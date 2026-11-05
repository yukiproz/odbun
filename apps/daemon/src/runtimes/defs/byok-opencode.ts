import { opencodeByokModelId } from '../byok-opencode.js';
import {
  OPENCODE_PERMISSION_CAPABILITY,
  appendOpenCodePermissionBypass,
} from '../opencode-permissions.js';
import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';

export const byokOpenCodeAgentDef = {
  id: 'byok-opencode',
  name: 'BYOK OpenCode',
  bin: 'opencode-cli',
  fallbackBins: ['opencode'],
  versionArgs: ['--version'],
  ...OPENCODE_PERMISSION_CAPABILITY,
  fallbackModels: [DEFAULT_MODEL_OPTION],
  buildArgs: (_prompt, _imagePaths, _extra, options = {}, _runtimeContext = {}) => {
    const args = ['run', '--format', 'json'];
    // No `--dir` argv: OpenCode v2 removed it. The workspace directory
    // reaches the child through the spawn itself — `cwd` (the runner spawns
    // with runtimeContext.cwd) plus `env.PWD` pinned to the same directory
    // via `applyOpenCodeWorkspaceEnv` at the spawn site in server.ts —
    // exactly the mechanism the main OpenCode def relies on (see
    // defs/opencode.ts). Managed OpenDesign projects live under the
    // development repository in local runs, and OpenCode promotes nested
    // directories to the enclosing Git worktree when only the process cwd
    // is set, so the PWD half of the pair is what keeps Write/Edit aimed
    // at the selected project instead of the repo root.
    appendOpenCodePermissionBypass(args, 'byok-opencode');
    const model = opencodeByokModelId(options.model);
    if (model) args.push('-m', model);
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'json-event-stream',
  eventParser: 'opencode',
  externalMcpInjection: 'opencode-env-content',
  supportsCustomModel: true,
} satisfies RuntimeAgentDef;
