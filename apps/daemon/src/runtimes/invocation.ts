import os from 'node:os';
import { createCommandInvocation } from '@open-design/platform';
import { execFileBun } from '../bun/spawn.js';
import type { RuntimeExecOptions } from './types.js';

// odbun R3: this probe path used to run on promisify(child_process.execFile).
// It now runs on execFileBun (bun/spawn.ts), which reproduces the
// promisified-execFile contract callers classify on — string errno
// `code` for spawn failures, numeric `code` for non-zero exits,
// `signal`/`killed`/`stdout`/`stderr` on the rejection. Behaviour
// notes live with the emulation in bun/spawn.ts.

// Agent probes (model-list / version / help / auth-status) are short read-only
// metadata calls that never need the caller's project files. Default them to a
// neutral working directory instead of inheriting the daemon process cwd.
//
// This matters because some agent CLIs are bun-based (OpenCode) and run a
// `bun install` on startup in their cwd to set up local plugins. When the daemon
// is launched from a pnpm workspace (e.g. a dev checkout), inheriting that cwd
// let an `opencode models` probe drop a workspace `bun.lock` + `node_modules/.bun`
// over the repo, wiping its pnpm store and breaking `next dev`. A probe writing a
// stray lockfile under the OS temp dir is harmless. Actual agent runs spawn
// elsewhere with an explicit project cwd and are unaffected.
export function execAgentFile(
  command: string,
  args: string[],
  options: RuntimeExecOptions = {},
) {
  const invocation = createCommandInvocation(
    options.env
      ? {
          command,
          args,
          env: options.env,
        }
      : {
          command,
          args,
        },
  );
  const cwdOption = options.cwd ?? os.tmpdir();
  return execFileBun(invocation.command, invocation.args, {
    // `timeout` alone is not a settle guarantee. The timeout only *signals*
    // on expiry, and the promise settles when the child actually exits. A
    // CLI that traps SIGTERM therefore leaves a probe pending forever, and
    // callers that await one before a Run can start park with it. These are
    // read-only metadata probes, so there is nothing to flush: kill them
    // outright. A caller's own killSignal still wins over this default.
    killSignal: options.killSignal ?? 'SIGKILL',
    // The bounded option surface execFileBun implements (audited: these
    // are the only fields execAgentFile call sites pass). Optional fields
    // are spread in only when defined: ExecFileBunOptions is an
    // exactOptionalPropertyTypes surface, and execFileBun reads absent
    // and undefined identically.
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    cwd: typeof cwdOption === 'string' ? cwdOption : decodeURIComponent(cwdOption.pathname),
    ...(invocation.windowsVerbatimArguments !== undefined
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
}
