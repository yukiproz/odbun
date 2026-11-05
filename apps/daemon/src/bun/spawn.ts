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

import { EventEmitter } from 'node:events';
import { constants as osConstants } from 'node:os';
import { PassThrough, Readable, Writable } from 'node:stream';

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
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: buildEnv(opts),
    stdin:
      opts.stdin === 'inherit' ? 'inherit'
      : opts.stdin === 'ignore' ? 'ignore'
      // Bun.spawn throws on a plain-string stdin at runtime (and
      // bun-types' SpawnOptions.Writable has no string member):
      // encode string input to the UTF-8 bytes it can only ever
      // have meant.
      : typeof opts.stdin === 'string' ? new TextEncoder().encode(opts.stdin)
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
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
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
    env: buildEnv({
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    }),
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

// ─── Node-shaped child process (agent runs, R3b) ────────────────────
// `runtimes/agent-process.ts` needs the full node:child_process surface
// its consumers were built on — an EventEmitter with `.pid`, Node
// Readable stdout/stderr, a Node Writable stdin, `kill()`, `killed`,
// `exitCode` / `signalCode`, and 'exit' / 'close' / 'error' events.
// Bun.spawn's Subprocess is none of that, so this wrapper adapts it.
// The exit-reporting translation is the load-bearing part:
//
//   Bun: signal death → `exited` RESOLVES 128+signum,
//        `proc.exitCode === null`, `proc.signalCode === 'SIGTERM'`.
//   Node shape consumers expect: exit/close fire with
//        (code === null, signal === 'SIGTERM'), `exitCode === null`,
//        `signalCode === 'SIGTERM'`.
//
// Semantics probed live on Bun 1.4.4 (2026-11-05):
// - `detached: true` DOES setsid: the child's pgid equals its pid, so
//   the daemon's `process.kill(-pgid, signal)` group signalling works
//   exactly as it did on Node-spawned group leaders.
// - stdin accepts a raw fd number and DUPS it at spawn, so the staged
//   prompt file hand-off (daemon closes + unlinks its own descriptor
//   right after spawn) is preserved byte-for-byte, delayed readers
//   included.
// - A spawn failure (ENOENT & friends) THROWS synchronously with the
//   errno on `.code`; Node reports it asynchronously. The wrapper
//   converts the throw back into Node's shape: an 'error' event on the
//   next macrotask, then 'close' with code = -errno, `pid` undefined,
//   `exitCode` still null.
// - The stdin FileSink accepts writes to an already-dead child
//   SILENTLY (no EPIPE). The PassThrough stdin below therefore never
//   raises the EPIPE 'error' Node would emit asynchronously;
//   consumers only ever used that event defensively (swallow EPIPE /
//   EOF, forward the rest), so its absence removes a crash vector
//   rather than a signal. Steering writes report `delivered` from the
//   PassThrough's own state, matching Node's write()-time view (the
//   race with a child exiting mid-write exists in both worlds).

export interface BunChildSpawnOptions {
  cwd?: string;
  /** REPLACES the child environment (spawn semantics — the daemon
   *  composes the agent env deliberately; it must not silently regain
   *  daemon variables), except that `PWD` is always forced to the
   *  effective cwd (the OpenCode v2 directory contract). */
  env?: Record<string, string | undefined>;
  /** `'pipe'` (live protocol stdin), `'ignore'`, or a raw fd number to
   *  inherit as the child's stdin (the staged prompt file). */
  stdin?: 'pipe' | 'ignore' | number;
  /** POSIX: the child leads its own process group (setsid). */
  detached?: boolean;
}

function buildReplaceEnv(opts: BunChildSpawnOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (typeof v === 'string') env[k] = v;
  }
  env.PWD = opts.cwd ?? env.PWD ?? process.cwd();
  return env;
}

/** Adapt one of Bun's web-readable stdio streams to a Node Readable.
 *  `drained` settles when the web side reaches EOF or the Node stream
 *  is destroyed — the two ways the child's 'close' may proceed. As in
 *  Node, a stream nobody reads keeps 'close' waiting on it; every
 *  daemon consumer attaches its readers synchronously after spawn. */
function webToNodeReadable(web: ReadableStream<Uint8Array>): {
  stream: Readable;
  drained: Promise<void>;
} {
  const reader = web.getReader();
  let settleDrained!: () => void;
  const drained = new Promise<void>((resolve) => { settleDrained = resolve; });
  const stream = new Readable({
    read() {
      reader.read().then(
        ({ done, value }) => {
          if (done) {
            settleDrained();
            if (!stream.destroyed) stream.push(null);
          } else if (!stream.destroyed) {
            stream.push(value);
          }
        },
        () => {
          // A broken read side is EOF for the wrapper's purposes; the
          // process exit state, not the pipe, classifies the run.
          settleDrained();
          if (!stream.destroyed) stream.push(null);
        },
      );
    },
    destroy(err, callback) {
      settleDrained();
      reader.cancel().catch(() => {}).finally(() => callback(err));
    },
  });
  return { stream, drained };
}

/** Node Writable stdin backed by the child's Bun FileSink. A
 *  PassThrough carries the genuine Writable contract (write()
 *  backpressure boolean, write callbacks, end(), destroyed, 'error'
 *  plumbing); a pump forwards its bytes into the sink, which delivers
 *  to the pipe without an explicit flush (probed). */
function nodeStdinFor(proc: Bun.Subprocess): Writable {
  const sink = proc.stdin as { write(chunk: unknown): unknown; end(): unknown };
  const stream = new PassThrough();
  void (async () => {
    try {
      for await (const chunk of stream) {
        try { sink.write(chunk); } catch { /* child gone — sink drops silently */ }
      }
    } catch {
      // Stream destroyed (teardown destroys stdio): fall through to end.
    }
    try { sink.end(); } catch { /* already closed */ }
  })();
  return stream;
}

function emptyReadable(): Readable {
  return Readable.from([]);
}

// ─── Signal-name translation ────────────────────────────────────────
// Bun's published types declare `Subprocess.signalCode` as
// `Signals | number | null`, but live probes on Bun 1.4.4 (this VM,
// 2026-11-06) show the runtime always yields the NAME string for a
// signal death — 'SIGTERM'/'SIGKILL'/'SIGUSR1', including kills issued
// with a numeric signal and kills delivered from outside the process —
// and null otherwise. The numeric arm is therefore defensive only. If
// a future or other-platform Bun ever returns a bare signum, the
// wrapper's Node contract (code=null, signal=<name>) must still hold,
// so the number is translated through the inverse of
// `os.constants.signals` instead of being dropped: dropping it would
// misreport the death as a normal 128+signum exit. A signum with no
// name in the table (e.g. a real-time signal between SIGRTMIN and
// SIGRTMAX) is rendered `SIG<n>` — not a canonical name, but truthful
// about the signum and still a signal, never an exit code.
const SIGNAL_NAME_BY_SIGNUM: ReadonlyMap<number, string> = (() => {
  const bySignum = new Map<number, string>();
  for (const [name, signum] of Object.entries(osConstants.signals)) {
    // Several names can share one signum (SIGABRT/SIGIOT = 6); the
    // first name in the constants table wins — any of them is the
    // correct Node-shaped answer for that signum.
    if (typeof signum === 'number' && !bySignum.has(signum)) {
      bySignum.set(signum, name);
    }
  }
  return bySignum;
})();

function toNodeSignalName(
  signal: string | number | null,
): string | null {
  if (signal === null) return null;
  if (typeof signal === 'string') return signal;
  return SIGNAL_NAME_BY_SIGNUM.get(signal) ?? `SIG${signal}`;
}

export class BunChildProcess extends EventEmitter {
  pid: number | undefined;
  stdin: Writable | null = null;
  stdout: Readable | null = null;
  stderr: Readable | null = null;
  /** Node shape: the exit code, or null when killed by a signal (or
   *  not yet exited, or the spawn itself failed). */
  exitCode: number | null = null;
  /** Node shape: the signal that ended the child, or null. */
  signalCode: string | null = null;
  /** True once a kill() signal was delivered (Node sets the same flag
   *  when `child.kill()` succeeds). */
  killed = false;

  #proc: Bun.Subprocess | null = null;

  static spawn(
    command: string,
    args: readonly string[],
    options: BunChildSpawnOptions = {},
  ): BunChildProcess {
    const child = new BunChildProcess();
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn([command, ...args], {
        cwd: options.cwd,
        env: buildReplaceEnv(options),
        stdin:
          options.stdin === 'pipe' ? 'pipe'
          : options.stdin === 'ignore' ? 'ignore'
          : options.stdin ?? 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: options.detached === true,
      } as Parameters<typeof Bun.spawn>[1]);
    } catch (error) {
      child.#attachSpawnFailure(error, options.stdin === 'pipe');
      return child;
    }
    child.#attach(proc, options.stdin === 'pipe');
    return child;
  }

  #attach(proc: Bun.Subprocess, stdinPiped: boolean): void {
    this.#proc = proc;
    this.pid = proc.pid;
    const out = webToNodeReadable(proc.stdout as ReadableStream<Uint8Array>);
    const err = webToNodeReadable(proc.stderr as ReadableStream<Uint8Array>);
    this.stdout = out.stream;
    this.stderr = err.stream;
    this.stdin = stdinPiped ? nodeStdinFor(proc) : null;
    void proc.exited.then((resolved) => {
      // The one translation that matters: Bun resolves 128+signum for
      // a signal death; consumers must observe Node's (null, signal).
      const signal = toNodeSignalName(proc.signalCode);
      const code = signal !== null
        ? null
        : (typeof proc.exitCode === 'number' ? proc.exitCode : resolved);
      this.exitCode = code;
      this.signalCode = signal;
      this.emit('exit', code, signal);
      // Node's 'close' follows 'exit' once the stdio streams are done.
      void Promise.all([out.drained, err.drained]).then(() => {
        this.emit('close', code, signal);
      });
    });
  }

  #attachSpawnFailure(error: unknown, stdinPiped: boolean): void {
    this.stdout = emptyReadable();
    this.stderr = emptyReadable();
    if (stdinPiped) {
      // A pre-destroyed stream: steering/close paths read `destroyed`
      // and refuse, exactly the answer for a child that never started.
      const stream = new PassThrough();
      stream.destroy();
      this.stdin = stream;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    const errnoName = (error as { code?: unknown } | null)?.code;
    const errno = typeof errnoName === 'string'
      ? (osConstants.errno as Record<string, number>)[errnoName]
      : undefined;
    const closeCode = typeof errno === 'number' ? -errno : -2;
    // Node delivers spawn failure asynchronously, after callers have
    // attached their handlers; one macrotask approximates that turn.
    setTimeout(() => {
      // EventEmitter throws on an unlistened 'error'. Node has the
      // same contract, but the daemon attaches its handler behind
      // awaits — if it is not there yet, 'close' below still carries
      // the failure into run classification, so skip instead of
      // crashing the daemon for a timing difference.
      if (this.listenerCount('error') > 0) this.emit('error', err);
      this.emit('close', closeCode, null);
    }, 0);
  }

  /** Deliver a signal to the child. Returns true when the signal was
   *  delivered (Node's return contract — `runs.ts` escalation logic
   *  branches on it), false when the child is already gone. */
  kill(signal: string | number = 'SIGTERM'): boolean {
    if (!this.#proc) return false;
    if (this.exitCode !== null || this.signalCode !== null) return false;
    try {
      this.#proc.kill(signal as never);
      this.killed = true;
      return true;
    } catch {
      return false;
    }
  }
}

/** Spawn a long-lived child with the node:child_process surface.
 *  Never throws for a spawn failure (see BunChildProcess); throws only
 *  for an empty command, like the other helpers in this module. */
export function spawnBunChild(
  command: string,
  args: readonly string[],
  options: BunChildSpawnOptions = {},
): BunChildProcess {
  if (!command) throw new Error('bun-spawn: empty command');
  return BunChildProcess.spawn(command, args, options);
}
