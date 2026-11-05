// R1 shim — the patch rewrites daemon imports of "better-sqlite3" to
// this module. Runtime imports get the bun:sqlite adapter as the default
// export (the `new Database(path, opts)` shape). Type-only imports in
// the daemon (`import type Database from "better-sqlite3"`) are erased
// at build time; the exported types below cover the namespace form
// (`import type * as BetterSqlite3 from "better-sqlite3"`).

import { BunSqliteDatabase } from "./bun-sqlite.ts";
import type { BunSqliteOptions, RunResult } from "./bun-sqlite.ts";

export type Database = BunSqliteDatabase;
export type Options = BunSqliteOptions;
export type RunResultType = RunResult;

export default BunSqliteDatabase;
