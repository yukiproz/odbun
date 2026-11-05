// odbun R2 — PTY adapter on Bun.spawn + Bun.Terminal (Bun 1.4),
// replacing the node-pty native addon at its single seam
// (`services/node-pty.ts` → `terminals.ts`). Adapted from the proven
// port-layer adapter in `port/runtime/pty/bun-terminal.ts` (spike 04:
// PTY echo round-trip PASS), widened to the exact surface the daemon's
// terminal service consumes from node-pty:
//
//   spawn(file, args, { name, cols, rows, cwd, env }) → process with
//   pid, onData(cb) → disposable, onExit(cb) → disposable,
//   write(data), resize(cols, rows), kill(signal?)
//
// There is deliberately NO fallback to node-pty and NO fallback to
// Node: if the Bun PTY surface is unavailable, `spawnBunPty` throws and
// `services/node-pty.ts` surfaces its existing unavailable error.
//
// Bun.Terminal specifics that shape this file (all probed live on
// Bun 1.4.4, 2026-11-05):
// - An open terminal holds the parent's event loop even after the
//   child exits (the spike-04 trap), so the terminal is closed
//   automatically once the exit has been delivered, and `close()`
//   is exposed for explicit teardown. `close()` is idempotent.
// - A signal-killed child reports `signalCode` ('SIGTERM') with
//   `exitCode === null`; the plain `exited` promise resolves with
//   128+signum. node-pty reports the signal as a NUMBER, so the name
//   is mapped back through `os.constants.signals` and exit listeners
//   keep receiving `{ exitCode, signal?: number }`.

import os from 'node:os';

export interface BunPtySpawnOptions {
  /** Terminal name (e.g. 'xterm-color'); carried for surface parity —
   *  exported to the child as TERM when the caller's env lacks one. */
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface BunPtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface BunPtyDisposable {
  dispose(): void;
}

type DataListener = (data: string) => void;
type ExitListener = (event: BunPtyExitEvent) => void;

export function bunPtySupported(): boolean {
  return typeof (Bun as any).Terminal === 'function';
}

export class BunPtyProcess {
  readonly pid: number;
  #cols: number;
  #rows: number;
  #terminal: any;
  #proc: any;
  #dataListeners = new Set<DataListener>();
  #exitListeners = new Set<ExitListener>();
  #closed = false;
  #exitDelivered = false;

  constructor(file: string, args: string[], options: BunPtySpawnOptions) {
    this.#cols = options.cols ?? 80;
    this.#rows = options.rows ?? 24;

    // Stream-decode so a multibyte character split across two PTY
    // chunks is delivered whole, matching node-pty's string surface.
    const decoder = new TextDecoder();
    const terminal = new (Bun as any).Terminal({
      cols: this.#cols,
      rows: this.#rows,
      data: (_term: unknown, data: Uint8Array) => {
        const text = decoder.decode(data, { stream: true });
        if (text) for (const listener of [...this.#dataListeners]) listener(text);
      },
    });
    this.#terminal = terminal;

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value;
    }
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (typeof value === 'string') env[key] = value;
    }
    if (options.name && !env.TERM) env.TERM = options.name;
    // Same directory contract as bun/spawn.ts: cwd and PWD agree.
    if (options.cwd) env.PWD = options.cwd;

    const proc = (Bun as any).spawn([file, ...args], {
      cwd: options.cwd,
      env,
      terminal,
    });
    this.#proc = proc;
    this.pid = proc.pid;

    proc.exited.then(
      (exitedCode: number) => {
        const tail = decoder.decode();
        if (tail) for (const listener of [...this.#dataListeners]) listener(tail);
        const signalName: string | null = proc.signalCode ?? null;
        const signum = signalName ? os.constants.signals[signalName as keyof typeof os.constants.signals] : undefined;
        const event: BunPtyExitEvent = {
          exitCode: typeof proc.exitCode === 'number' ? proc.exitCode : exitedCode,
          ...(typeof signum === 'number' ? { signal: signum } : {}),
        };
        this.#exitDelivered = true;
        for (const listener of [...this.#exitListeners]) {
          try { listener(event); } catch { /* a listener must not block teardown */ }
        }
        // The child is gone; an open terminal would now only pin the
        // daemon's event loop. Close it (idempotent) after delivery.
        this.close();
      },
      () => {
        // Bun's exited promise does not reject for spawn failures
        // (spawn throws synchronously instead); this branch is purely
        // defensive so a rejection can never surface as unhandled.
        this.close();
      },
    );
  }

  get cols(): number {
    return this.#cols;
  }

  get rows(): number {
    return this.#rows;
  }

  onData(listener: DataListener): BunPtyDisposable {
    this.#dataListeners.add(listener);
    return { dispose: () => this.#dataListeners.delete(listener) };
  }

  onExit(listener: ExitListener): BunPtyDisposable {
    this.#exitListeners.add(listener);
    return { dispose: () => this.#exitListeners.delete(listener) };
  }

  write(data: string): void {
    this.#terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    this.#cols = cols;
    this.#rows = rows;
    this.#terminal.resize(cols, rows);
  }

  /** Signal the child. Accepts a signal name ('SIGTERM') like
   *  node-pty's kill, or nothing for Bun's default (SIGTERM). */
  kill(signal?: string): void {
    if (signal) this.#proc.kill((os.constants.signals as Record<string, number>)[signal] ?? signal);
    else this.#proc.kill();
  }

  /** Close the terminal itself. Killing the process alone leaves the
   *  PTY open and keeps the parent's event loop alive (spike-04
   *  finding). Idempotent; also runs automatically after exit. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#terminal.close();
    } catch {
      // Already closed by the runtime — close() is idempotent.
    }
  }

  /** True once an exit event has been delivered to listeners. */
  get exited(): boolean {
    return this.#exitDelivered;
  }
}

export function spawnBunPty(
  file: string,
  args: string[] = [],
  options: BunPtySpawnOptions = {},
): BunPtyProcess {
  if (!bunPtySupported()) {
    throw new Error(
      'bun/pty: Bun.Terminal unavailable in this Bun build — R2 gate failed; report, do not fall back',
    );
  }
  return new BunPtyProcess(file, args, options);
}
