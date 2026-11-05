import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { DEFAULT_MODEL_OPTION, execAgentFile } from './shared.js';
import {
  OPENCODE_PERMISSION_CAPABILITY,
  appendOpenCodePermissionBypass,
} from '../opencode-permissions.js';
import { getRememberedLiveModels } from '../models.js';
import type { RuntimeAgentDef, RuntimeModelOption } from '../types.js';

const OPENCODE_VARIANT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const OPENCODE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/:@-]*$/u;

function reasoningOptions(ids: readonly string[]): RuntimeModelOption[] {
  return [
    { id: 'default', label: 'Default' },
    ...ids.map((id) => ({ id, label: id })),
  ];
}

const OPENCODE_FALLBACK_MODELS: RuntimeModelOption[] = [
  DEFAULT_MODEL_OPTION,
  {
    id: 'anthropic/claude-sonnet-4-5',
    label: 'anthropic/claude-sonnet-4-5',
  },
  {
    id: 'openai/gpt-5.6-sol',
    label: 'openai/gpt-5.6-sol',
  },
  {
    id: 'openai/gpt-5.6-terra',
    label: 'openai/gpt-5.6-terra',
  },
  {
    id: 'openai/gpt-5.6-luna',
    label: 'openai/gpt-5.6-luna',
  },
  { id: 'openai/gpt-5', label: 'openai/gpt-5' },
  { id: 'google/gemini-2.5-pro', label: 'google/gemini-2.5-pro' },
];

function parseVerboseModelMetadata(
  lines: string[],
  start: number,
): { value: Record<string, unknown> | null; end: number } {
  let buffer = '';
  for (let index = start; index < lines.length; index += 1) {
    buffer += `${lines[index]}\n`;
    if (!lines[index]!.trimEnd().endsWith('}')) continue;
    try {
      const parsed = JSON.parse(buffer) as unknown;
      return {
        value: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null,
        end: index,
      };
    } catch {
      // Nested objects close before the outer metadata object. Keep reading
      // until the complete JSON value parses.
    }
  }
  return { value: null, end: start - 1 };
}

/**
 * Parse `opencode models` output. OpenCode v2 prints one `provider/model`
 * id per line and no variant metadata, so this parse can only ever produce
 * plain ids; reasoning variants are discovered separately by
 * {@link fetchOpenCodeModels} from the v2 server API and merged in. (A
 * verbose JSON block after an id is still tolerated if a build emits one,
 * but nothing in v2 does.)
 */
export function parseOpenCodeModels(stdout: string): RuntimeModelOption[] | null {
  const lines = String(stdout || '').split('\n');
  const models: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const id = lines[index]!.trim();
    if (!OPENCODE_MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const next = lines[index + 1]?.trimStart();
    const metadata = next?.startsWith('{')
      ? parseVerboseModelMetadata(lines, index + 1)
      : { value: null, end: index };
    const variants = metadata.value?.['variants'];
    const variantIds = variants && typeof variants === 'object' && !Array.isArray(variants)
      ? Object.keys(variants).filter((variant) => OPENCODE_VARIANT_ID.test(variant))
      : [];
    models.push({
      id,
      label: id,
      ...(variantIds.length > 0
        ? { reasoningOptions: reasoningOptions(variantIds) }
        : {}),
    });
    index = Math.max(index, metadata.end);
  }
  return models.length > 1 ? models : null;
}

/**
 * Parse the v2 server API's `GET /api/model` payload (`Model.Info[]`).
 * Each entry carries its reasoning `variants` — the data the v2 CLI's
 * plain `models` listing no longer prints, and the only source from
 * which the picker can offer reasoning choices. Entry ids may be bare
 * model ids with a separate provider field, or already-qualified
 * `provider/model` ids; both are normalised to the qualified form the
 * rest of the daemon uses. Unknown shapes yield `null`, never a throw.
 */
export function parseOpenCodeModelInfo(payload: unknown): RuntimeModelOption[] | null {
  const entries: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : payload && typeof payload === 'object'
        ? Object.values(payload as Record<string, unknown>)
        : [];
  const models: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const rawId = typeof record.id === 'string' ? record.id.trim() : '';
    if (!rawId) continue;
    const provider = [record.providerID, record.providerId, record.provider]
      .find((value): value is string => typeof value === 'string' && value.length > 0);
    const id = rawId.includes('/') ? rawId : provider ? `${provider}/${rawId}` : rawId;
    if (!OPENCODE_MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const rawVariants = record.variants;
    const variantIds = Array.isArray(rawVariants)
      ? rawVariants
          .map((variant) =>
            typeof variant === 'string'
              ? variant
              : variant && typeof variant === 'object' && typeof (variant as { id?: unknown }).id === 'string'
                ? ((variant as { id: string }).id)
                : '',
          )
          .filter((variant) => OPENCODE_VARIANT_ID.test(variant))
      : rawVariants && typeof rawVariants === 'object'
        ? Object.keys(rawVariants).filter((variant) => OPENCODE_VARIANT_ID.test(variant))
        : [];
    models.push({
      id,
      label: id,
      ...(variantIds.length > 0
        ? { reasoningOptions: reasoningOptions(variantIds) }
        : {}),
    });
  }
  return models.length > 1 ? models : null;
}

const OPENCODE_SERVER_PROBE_TIMEOUT_MS = 15_000;

/**
 * Boot a one-shot OpenCode v2 server exactly the way the v2 CLI does —
 * `opencode serve --stdio --port 0` with a random `OPENCODE_PASSWORD`,
 * first stdout line is the base URL — and read `GET /api/model` from it.
 * Any failure (spawn error, no URL line, HTTP error, timeout) resolves
 * to `null`: variant discovery must never break the plain model list.
 */
async function fetchOpenCodeModelInfoFromServer(
  resolvedBin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RuntimeModelOption[] | null> {
  const password = randomBytes(18).toString('hex');
  const child = spawn(resolvedBin, ['serve', '--stdio', '--port', '0'], {
    cwd: tmpdir(),
    env: { ...env, OPENCODE_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    const baseUrl = await new Promise<string | null>((resolve) => {
      let buffer = '';
      const timer = setTimeout(() => resolve(null), timeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        const match = buffer.match(/https?:\/\/[^\s]+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0].replace(/\/+$/, ''));
        }
      });
      child.once('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.once('close', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    if (!baseUrl) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/api/model`, {
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return parseOpenCodeModelInfo(await response.json());
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  } finally {
    child.kill();
  }
}

/**
 * v2 model discovery for the picker. The CLI listing supplies the model
 * ids; the one-shot server supplies each model's reasoning variants.
 * The two are merged by id. If the server probe fails, the plain CLI
 * list is returned untouched; if the CLI listing also fails, `null`
 * lets detection fall back to the static fallback models. Nothing here
 * throws — listing must never break because discovery did.
 */
async function fetchOpenCodeModels(
  resolvedBin: string,
  env: NodeJS.ProcessEnv,
): Promise<RuntimeModelOption[] | null> {
  let plain: RuntimeModelOption[] | null = null;
  try {
    const { stdout } = await execAgentFile(resolvedBin, ['models'], {
      env,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    plain = parseOpenCodeModels(String(stdout));
  } catch {
    plain = null;
  }
  const fromServer = await fetchOpenCodeModelInfoFromServer(
    resolvedBin,
    env,
    OPENCODE_SERVER_PROBE_TIMEOUT_MS,
  ).catch(() => null);
  if (!fromServer) return plain;
  if (!plain) return fromServer;
  const variantsById = new Map(
    fromServer
      .filter((model) => model.id !== 'default' && model.reasoningOptions)
      .map((model) => [model.id, model.reasoningOptions]),
  );
  return plain.map((model) => {
    const reasoning = variantsById.get(model.id);
    return reasoning && !model.reasoningOptions
      ? { ...model, reasoningOptions: reasoning }
      : model;
  });
}

function supportsOpenCodeVariant(
  modelId: string | null | undefined,
  variant: string | null | undefined,
): variant is string {
  if (!modelId || modelId === 'default' || !variant || variant === 'default') return false;
  const live = getRememberedLiveModels('opencode').find((model) => model.id === modelId);
  return Boolean(live?.reasoningOptions?.some((option) => option.id === variant));
}

export const opencodeAgentDef = {
    id: 'opencode',
    name: 'OpenCode',
    bin: 'opencode-cli',
    fallbackBins: ['opencode'],
    versionArgs: ['--version'],
    ...OPENCODE_PERMISSION_CAPABILITY,
    // `opencode models` prints `provider/model` per line. Real-world
    // `opencode models` calls can take >8s (network round-trip to the
    // provider registry), so the previous 8s budget timed out and fell back
    // to the hardcoded `fallbackModels`, hiding the user's actual catalog.
    // 15s matches the listModels budget the rest of the agent defs use
    // (devin, hermes, kiro, kilo, kimi, trae-cli, vibe, reasonix).
    // v2 `opencode models` prints plain `provider/model` ids only — the
    // `--verbose` metadata form is gone. `fetchModels` (preferred by
    // detection whenever present) merges in each model's reasoning
    // variants from the one-shot server's `/api/model`; this declarative
    // listing remains as the plain-id source inside that merge.
    listModels: {
      args: ['models'],
      parse: parseOpenCodeModels,
      timeoutMs: 15_000,
    },
    fetchModels: fetchOpenCodeModels,
    fallbackModels: OPENCODE_FALLBACK_MODELS,
    // Reasoning variants come from the v2 server API (`Model.Info`
    // variants), remembered by `fetchModels` above. The fallback keeps
    // Sol/Terra/Luna model ids usable during a catalog outage but does
    // not guess their variants. Unknown model/variant pairs run the base
    // model without a variant rather than inventing a provider
    // capability or preventing the run.
    //
    // Prompt delivered via stdin (`opencode run` with no message argv) to
    // avoid Windows `spawn ENAMETOOLONG` while preserving OpenCode's
    // structured stream. A literal `-` is parsed as a positional message by
    // OpenCode 1.14.x and can surface as "Session not found".
    buildArgs: (_prompt, _imagePaths, _extra, options = {}, runtimeContext = {}) => {
      const args = [
        'run',
        '--format',
        'json',
      ];
      appendOpenCodePermissionBypass(args, 'opencode');
      // No `--dir` argv: OpenCode v2 removed it. The workspace directory
      // reaches the child through the spawn itself — `cwd` (the runner
      // spawns with runtimeContext.cwd) plus `env.PWD` pinned to the same
      // directory via `applyOpenCodeWorkspaceEnv` at the spawn site,
      // because a spawn `cwd` alone does not update the child's PWD and
      // v2 resolves `options.root ?? env.PWD ?? process.cwd()`.
      // Capture-style resume: OpenCode mints its own session id (reported on
      // the stream as `sessionID`, e.g. `ses_...`). On a follow-up turn the
      // daemon continues that session with `-s <id>` instead of re-sending the
      // flattened transcript, so the first upstream call reuses the warm prefix
      // cache. `-s` continues an EXISTING session (the create turn passes no id
      // and we capture the one OpenCode generated), mirroring codex.
      const resumeSessionId =
        typeof runtimeContext.resumeSessionId === 'string' &&
        runtimeContext.resumeSessionId.length > 0
          ? runtimeContext.resumeSessionId
          : null;
      if (resumeSessionId) {
        args.push('-s', resumeSessionId);
      }
      // v2 has no `--variant` flag: a reasoning variant is folded into
      // the model selector as `-m provider/model#variant`.
      const variant = supportsOpenCodeVariant(options.model, options.reasoning)
        ? options.reasoning
        : null;
      if (options.model && options.model !== 'default') {
        args.push('-m', variant ? `${options.model}#${variant}` : options.model);
      }
      return args;
    },
    promptViaStdin: true,
    // OpenCode's CLI carries its own session across spawns: on a follow-up turn
    // the daemon resumes the captured session id (`-s <id>`) instead of
    // re-flattening the transcript. Capture-style — the resume handle is the
    // `sessionID` captured from the stream, not a daemon-minted id.
    resumesSessionViaCli: true,
    capturesSessionIdFromStream: true,
    streamFormat: 'json-event-stream',
    eventParser: 'opencode',
    // OpenCode reads MCP servers from its layered config (global ~/.config
    // /opencode/opencode.json + project opencode.json + OPENCODE_CONFIG
    // + OPENCODE_CONFIG_CONTENT). The env-var form lets the daemon hand
    // user-configured external MCP servers to a single `opencode run`
    // invocation without polluting the user's saved config files. See
    // <https://opencode.ai/docs/config> and issue #2142.
    externalMcpInjection: 'opencode-env-content',
} satisfies RuntimeAgentDef;
