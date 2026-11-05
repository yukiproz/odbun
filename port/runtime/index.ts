// Bun-native runtime adapters — the only place Bun-specific APIs live,
// so the patch set stays small and auditable (and a future port
// rewrites files, not archaeology).

export { BunSqliteDatabase } from "./db/bun-sqlite.ts";
export type { BunSqliteOptions, RunResult } from "./db/bun-sqlite.ts";
export { spawnCapture, spawnStreaming } from "./proc/bun-spawn.ts";
export type { SpawnOptions, SpawnResult } from "./proc/bun-spawn.ts";
export { spawnPty, ptySupported } from "./pty/bun-terminal.ts";
export type { PtyOptions, PtyHandle } from "./pty/bun-terminal.ts";
export { serveProbe } from "./http/bun-serve.ts";
export { nativeFetch } from "./fetch/native-fetch.ts";
