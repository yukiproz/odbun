// R2 — PTY adapter on Bun.spawn + Bun.Terminal (Bun 1.4), replacing
// node-pty at its single seam (daemon: services/node-pty.ts →
// terminals.ts). SPIKE-GATED: spikes/04-terminal.ts must pass on the
// target machine before this adapter is wired into the daemon build.
// If the Bun PTY surface is unavailable, spawnPty throws explicitly —
// there is deliberately NO fallback to node-pty and NO fallback to
// Node (radical decision, 2026-11-05).

export interface PtyOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  onData: (text: string) => void;
}

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Close the terminal itself — killing the process alone leaves the
   *  PTY open and keeps the parent's event loop alive (found by
   *  spike 04, 2026-11-05: PASS printed but the process never exited). */
  close(): void;
  exited: Promise<number>;
}

export function ptySupported(): boolean {
  return typeof (Bun as any).Terminal === "function";
}

export function spawnPty(
  command: string,
  args: string[],
  opts: PtyOptions,
): PtyHandle {
  if (!ptySupported()) {
    throw new Error(
      "bun-terminal: Bun.Terminal unavailable in this Bun build — R2 spike gate failed; report, do not fall back",
    );
  }
  const decoder = new TextDecoder();
  const terminal = new (Bun as any).Terminal({
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    data(_term: unknown, data: Uint8Array) {
      opts.onData(decoder.decode(data));
    },
  });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (typeof v === "string") env[k] = v;
  }
  if (opts.cwd) env.PWD = opts.cwd;

  const proc = (Bun as any).spawn([command, ...args], {
    cwd: opts.cwd,
    env,
    terminal,
  });

  return {
    write(data: string) {
      terminal.write(data);
    },
    resize(cols: number, rows: number) {
      terminal.resize(cols, rows);
    },
    kill() {
      proc.kill();
    },
    close() {
      try {
        terminal.close();
      } catch {
        // already closed — close() is idempotent by contract
      }
    },
    exited: proc.exited as Promise<number>,
  };
}
