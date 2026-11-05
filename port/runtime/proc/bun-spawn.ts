// R3 — canonical Bun.spawn helper for the paths that used child_process.
//
// OpenCode v2 contract (seed brief P1): the v2 CLI has no `--dir` flag.
// The working directory is conveyed by the child process's cwd AND its
// `PWD` environment variable (the correction upstream's maintainer
// required in PR #8479). This helper always sets `PWD` = effective cwd
// so no call site can forget it.

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string | Uint8Array | "inherit" | "ignore";
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function buildEnv(opts: SpawnOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (typeof v === "string") env[k] = v;
  }
  // The v2 directory contract — always, not per call site.
  env.PWD = opts.cwd ?? env.PWD ?? process.cwd();
  return env;
}

/** Spawn to completion, capturing stdout/stderr as text. */
export async function spawnCapture(
  cmd: string[],
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  if (cmd.length === 0) throw new Error("bun-spawn: empty command");
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: buildEnv(opts),
    stdin:
      opts.stdin === "inherit" ? "inherit"
      : opts.stdin === "ignore" ? "ignore"
      : opts.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
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
  if (cmd.length === 0) throw new Error("bun-spawn: empty command");
  return Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: buildEnv(opts),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}
