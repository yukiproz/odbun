// odbun R3 — canonical Bun.spawn helpers for the daemon paths that
// used node:child_process. Adapted from the proven port-layer helper
// in `port/runtime/proc/bun-spawn.ts` (tests + spike 02 PASS).
//
// Directory contract (OpenCode v2, seed brief P1): the v2 CLI has no
// `--dir` flag. The working directory is conveyed by the child's cwd
// AND its `PWD` environment variable (the correction upstream's
// maintainer required in PR #8479). Every helper here sets
// `PWD` = effective cwd so no call site can forget it.
//
// Semantics probed live on Bun 1.4.4 (2026-11-05):
// - Bun.spawn of a missing binary THROWS synchronously with
//   `err.code === 'ENOENT'` (Node reports it asynchronously) — the
//   execFile emulation below converts that back into a rejection
//   carrying the same string `code` callers classify on.
// - A signal-killed child: `exited` resolves 128+signum,
//   `proc.exitCode === null`, `proc.signalCode === 'SIGTERM'`.
// - Bun.spawnSync supports `timeout` (result carries
//   `exitedDueToTimeout`, exitCode null) and also throws on ENOENT.

// ─── Shared env ─────────────────────────────────────────────────────

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string | Uint8Array | 'inherit' | 'ignore';
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function buildEnv(opts: SpawnOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (typeof v === 'string') env[k] = v;
  }
  // The v2 directory contract — always, not per call site.
  env.PWD = opts.cwd ?? env.PWD ?? process.cwd();
  return env;
}

// ─── Capture / streaming (port-proven shapes) ───────────────────────

/** Spawn to completion, capturing stdout/stderr as text. */
export async function spawnCapture(
  cmd: string[],
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  if (cmd.length === 0) throw new Error('bun-spawn: empty command');
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: buildEnv(opts),
    stdin:
      opts.stdin === 'inherit' ? 'inherit'
      : opts.stdin === 'ignore' ? 'ignore'
      : opts.stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Spawn for streaming consumers (agent runtimes): returns the live
 *  subprocess; stdout/stderr are pipes the caller reads. */
export function spawnStreaming(cmd: string[], opts: SpawnOptions = {}) {
  if (cmd.length === 0) throw new Error('bun-spawn: empty command');
  return Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: buildEnv(opts),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

/**
 * Spawn a long-lived, fire-and-forget process whose lifetime is
 * independent of the daemon (system-terminal launches). Bun.spawn
 * throws synchronously when the binary cannot be spawned (ENOENT),
 * so a returned process is a started process; `unref()` mirrors
 * node:child_process's `child.unref()` so the child never keeps the
 * daemon alive. NOTE: Bun 1.4.4 accepts the `detached` flag without
 * error, but its process-group semantics are not Node's setsid
 * guarantee — callers must treat this as best-effort detachment.
 */
export function spawnDetached(cmd: string[], opts: SpawnOptions = {}) {
  if (cmd.length === 0) throw new Error('bun-spawn: empty command');
  const proc = (Bun as any).spawn(cmd, {
    cwd: opts.cwd,
    env: buildEnv(opts),
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  });
  proc.unref();
  return proc;
}

// ─── Synchronous capture (version probes) ───────────────────────────

export interface SpawnSyncResult {
  /** Null when the child died by signal or the timeout killed it. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Bun.spawnSync counterpart of node:child_process's spawnSync with
 * utf8 output. Throws (with `.code` set, e.g. 'ENOENT') when the
 * binary cannot be spawned at all — callers that probe treat a throw
 * and an empty result the same way.
 */
export function spawnSyncCapture(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number } = {},
): SpawnSyncResult {
  const result = (Bun as any).spawnSync([file, ...args], {
    cwd: opts.cwd,
    env: buildEnv({ cwd: opts.cwd, env: opts.env }),
    timeout: opts.timeout,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const decoder = new TextDecoder();
  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    stdout: result.stdout ? decoder.decode(result.stdout) : '',
    stderr: result.stderr ? decoder.decode(result.stderr) : '',
    timedOut: result.exitedDueToTimeout === true,
  };
}

// ─── execFile emulation ─────────────────────────────────────────────
// The daemon's probe layer was built on promisify(child_process.execFile)
// and its callers classify failures off the rejection's fields:
//   err.code    string errno ('ENOENT') for spawn failures,
//               NUMBER for non-zero exits, null for signal deaths
//   err.signal  signal name string or null
//   err.killed  true only when the parent side killed the child
//               (timeout / maxBuffer / abort)
//   err.stdout / err.stderr   (partial) output strings
// execFileBun reproduces exactly that contract on Bun.spawn. The
// option surface is deliberately bounded to what daemon call sites
// actually pass (env, timeout, maxBuffer — audited 2026-11-05) plus
// killSignal / cwd / AbortSignal; anything else throws loudly
// instead of being silently ignored.

export interface ExecFileBunOptions {
  cwd?: string;
  /** REPLACES the child environment (execFile semantics — callers
   *  that want inheritance spread process.env themselves), except
   *  that PWD is always aligned to the effective cwd. */
  env?: Record<string, string | undefined>;
  timeout?: number;
  maxBuffer?: number;
  killSignal?: string | number;
  signal?: AbortSignal;
  /** Accepted for call-site parity; a no-op off Windows, exactly as
   *  in Node on POSIX. */
  windowsVerbatimArguments?: boolean;
}

export class ExecFileError extends Error {
  code: string | number | null;
  signal: string | null;
  killed: boolean;
  stdout: string;
  stderr: string;

  constructor(message: string, fields: {
    code: string | number | null;
    signal: string | null;
    killed: boolean;
    stdout: string;
    stderr: string;
  }) {
    super(message);
    this.name = 'ExecFileError';
    this.code = fields.code;
    this.signal = fields.signal;
    this.killed = fields.killed;
    this.stdout = fields.stdout;
    this.stderr = fields.stderr;
  }
}

const DEFAULT_MAX_BUFFER = 1024 * 1024;

export function execFileBun(
  file: string,
  args: string[],
  options: ExecFileBunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const killSignal = options.killSignal ?? 'SIGTERM';
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;

  const env: Record<string, string> = {};
  const baseEnv = options.env ?? process.env;
  for (const [k, v] of Object.entries(baseEnv)) {
    if (typeof v === 'string') env[k] = v;
  }
  env.PWD = options.cwd ?? env.PWD ?? process.cwd();

  return new Promise((resolve, reject) => {
    let proc: any;
    try {
      proc = (Bun as any).spawn([file, ...args], {
        cwd: options.cwd,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (error: any) {
      // Spawn failure (ENOENT/EACCES/...): Bun throws synchronously
      // with the errno on `.code`; promisified execFile rejects with
      // the same string code. Preserve it verbatim — version/auth
      // probe classifiers branch on it.
      reject(new ExecFileError(error?.message ?? `spawn failed: ${file}`, {
        code: typeof error?.code === 'string' ? error.code : null,
        signal: null,
        killed: false,
        stdout: '',
        stderr: '',
      }));
      return;
    }

    let settled = false;
    let timedOut = false;
    let bufferExceeded = false;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      options.signal?.removeEventListener?.('abort', onAbort);
    };
    const kill = () => {
      try { proc.kill(killSignal as any); } catch { /* already gone */ }
    };
    const onAbort = () => { aborted = true; kill(); };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => { timedOut = true; kill(); }, options.timeout);
      (timer as any).unref?.();
    }

    const readCapped = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
        if (total > maxBuffer && !bufferExceeded) {
          bufferExceeded = true;
          kill();
        }
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
      return out;
    };

    (async () => {
      try {
        const [stdoutBytes, stderrBytes] = await Promise.all([
          readCapped(proc.stdout),
          readCapped(proc.stderr),
        ]);
        await proc.exited;
        if (settled) return;
        settled = true;
        cleanup();
        const decoder = new TextDecoder();
        const stdout = decoder.decode(stdoutBytes);
        const stderr = decoder.decode(stderrBytes);
        const signal: string | null = proc.signalCode ?? null;
        const exitCode: number | null = typeof proc.exitCode === 'number' ? proc.exitCode : null;
        const commandLine = [file, ...args].join(' ');
        if (aborted) {
          reject(new ExecFileError(`Command aborted: ${commandLine}`, {
            code: 'ABORT_ERR', signal, killed: true, stdout, stderr,
          }));
        } else if (timedOut) {
          reject(new ExecFileError(`Command timed out: ${commandLine}`, {
            code: null, signal: typeof killSignal === 'string' ? killSignal : signal, killed: true, stdout, stderr,
          }));
        } else if (bufferExceeded) {
          reject(new ExecFileError(`Command exceeded maxBuffer: ${commandLine}`, {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', signal: typeof killSignal === 'string' ? killSignal : signal, killed: true, stdout, stderr,
          }));
        } else if (signal) {
          reject(new ExecFileError(`Command killed by ${signal}: ${commandLine}`, {
            code: null, signal, killed: false, stdout, stderr,
          }));
        } else if (exitCode !== 0) {
          reject(new ExecFileError(`Command failed: ${commandLine}\n${stderr}`, {
            code: exitCode, signal: null, killed: false, stdout, stderr,
          }));
        } else {
          resolve({ stdout, stderr });
        }
      } catch (error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    })();
  });
}
