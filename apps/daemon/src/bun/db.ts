// R1 (odbun port) — bun:sqlite adapter replacing better-sqlite3.
//
// Every daemon import of 'better-sqlite3' now points at this module.
// The default export is a Database class with the better-sqlite3 shape
// the daemon actually uses — measured on the v0.27.0 source (see
// port/DESIGN.md §2): prepare (615 call sites), exec (394),
// transaction (82), pragma (12), plus the `inTransaction` guards in
// collab/* and the manual `BEGIN EXCLUSIVE` lock in
// storage/touchpoint-replay-authority.ts.
//
// Adapted from the proven adapter in port/runtime/db/bun-sqlite.ts,
// with daemon-specific additions, each verified against Bun 1.4.4
// before being written here:
//   - `inTransaction` delegates to bun:sqlite's own property, which
//     also reflects transactions started by a raw exec('BEGIN …') —
//     a per-adapter counter would miss those (touchpoint lock).
//   - `pragma()` returns result rows for write pragmas too, like
//     better-sqlite3 (the port version returned undefined).
//   - `transaction()` is implemented with BEGIN/SAVEPOINT semantics
//     (including .deferred/.immediate/.exclusive/.default), matching
//     better-sqlite3, instead of delegating to bun's helper.
//   - Statement gains bind()/columns() (bun exposes columnNames).
//   - BLOB results are converted from Uint8Array to Buffer (see
//     convertRow below): bun:sqlite returns Uint8Array for BLOB
//     columns, better-sqlite3 returns Buffer, and daemon consumers
//     rely on Buffer semantics (`.toString()` decoding, hashing,
//     JSON.parse of stored payloads). Without the conversion a
//     stored text blob reads back as "104,101,108,108,111,…".
//
// This is the contract, not a full better-sqlite3 clone. Surface the
// daemon does not use and bun:sqlite cannot faithfully provide
// (pluck/expand/safeIntegers modes, aggregate/table/function
// registration) throws loudly instead of silently behaving
// differently — a quiet wrong answer from the DB layer is worse
// than a crash.

import { Database as BunDatabase } from "bun:sqlite";
import { existsSync } from "node:fs";

/** better-sqlite3 returns Buffer for BLOB columns; bun:sqlite returns
 *  Uint8Array. Convert blob values in result rows back to Buffer so
 *  consumers see the contract they were written against. Rows without
 *  blob values are returned untouched (identity preserved). */
function blobValue(value: unknown): unknown {
  return value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value)
    : value;
}

function convertRow(row: unknown): unknown {
  if (row === null || typeof row !== "object") return row;
  if (Array.isArray(row)) {
    // raw-mode value arrays
    let out: unknown[] | null = null;
    for (let i = 0; i < row.length; i++) {
      const converted = blobValue(row[i]);
      if (converted !== row[i]) {
        out ??= row.slice();
        out[i] = converted;
      }
    }
    return out ?? row;
  }
  let out: Record<string, unknown> | null = null;
  for (const key of Object.keys(row)) {
    const value = (row as Record<string, unknown>)[key];
    const converted = blobValue(value);
    if (converted !== value) {
      out ??= { ...(row as Record<string, unknown>) };
      out[key] = converted;
    }
  }
  return out ?? row;
}

class AdapterStatement {
  private rawMode = false;
  private boundParams: unknown[] = [];
  constructor(private stmt: any) {}

  raw(mode = true): this {
    this.rawMode = mode;
    return this;
  }
  pluck(): this {
    throw new Error("bun db adapter: statement .pluck() is not implemented (unused by the daemon)");
  }
  expand(): this {
    throw new Error("bun db adapter: statement .expand() is not implemented (unused by the daemon)");
  }
  safeIntegers(): this {
    throw new Error("bun db adapter: statement .safeIntegers() is not implemented (unused by the daemon)");
  }

  /** Permanently bind parameters, prepended to per-call parameters. */
  bind(...params: unknown[]): this {
    this.boundParams = params;
    return this;
  }

  columns(): Database.ColumnDefinition[] {
    const names: string[] = Array.isArray(this.stmt.columnNames) ? this.stmt.columnNames : [];
    return names.map((name) => ({
      name,
      column: name,
      table: null,
      database: null,
      type: null,
    }));
  }

  private args(params: unknown[]): unknown[] {
    return this.boundParams.length ? [...this.boundParams, ...params] : params;
  }

  run(...params: unknown[]): Database.RunResult {
    const r = this.stmt.run(...this.args(params));
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }
  get(...params: unknown[]): unknown {
    const p = this.args(params);
    if (this.rawMode) {
      const rows = this.stmt.values(...p);
      return rows.length ? convertRow(rows[0]) : undefined;
    }
    const row = this.stmt.get(...p);
    // better-sqlite3 returns undefined for no row; bun:sqlite returns null.
    return row === null ? undefined : convertRow(row);
  }
  all(...params: unknown[]): unknown[] {
    const p = this.args(params);
    if (this.rawMode) return (this.stmt.values(...p) as unknown[]).map(convertRow);
    return (this.stmt.all(...p) as unknown[]).map(convertRow);
  }
  *iterate(...params: unknown[]): IterableIterator<unknown> {
    const p = this.args(params);
    if (typeof this.stmt.iterate === "function") {
      for (const row of this.stmt.iterate(...p)) yield convertRow(row);
    } else {
      yield* this.all(...p);
    }
  }
}

export class Database {
  private db: BunDatabase;
  private closed = false;
  private txDepth = 0;
  private readonlyFlag: boolean;
  private memoryFlag: boolean;

  constructor(path: string, options: Database.Options = {}) {
    if (options.nativeBinding !== undefined) {
      throw new Error("bun db adapter: the nativeBinding option has no bun:sqlite equivalent");
    }
    if (options.fileMustExist && path !== ":memory:" && !existsSync(path)) {
      throw new Error(`bun db adapter: fileMustExist but no such file: ${path}`);
    }
    this.readonlyFlag = options.readonly ?? false;
    this.memoryFlag = path === ":memory:" || path === "";
    this.db = new BunDatabase(path, {
      create: !this.readonlyFlag,
      readonly: this.readonlyFlag,
    });
    if (options.timeout && options.timeout > 0) {
      this.db.exec(`PRAGMA busy_timeout = ${Math.floor(options.timeout)}`);
    }
  }

  get open(): boolean {
    return !this.closed;
  }
  /** True whenever SQLite is inside a transaction — including ones
   *  started by a raw exec('BEGIN …'), which the daemon's lock code
   *  (storage/touchpoint-replay-authority.ts) relies on. Delegates to
   *  bun:sqlite's own tracking (verified on Bun 1.4.4). */
  get inTransaction(): boolean {
    return (this.db as any).inTransaction === true;
  }
  get readonly(): boolean {
    return this.readonlyFlag;
  }
  get memory(): boolean {
    return this.memoryFlag;
  }
  get name(): string {
    // bun:sqlite does not expose the filename; better-sqlite3's `name`
    // is unused by the daemon.
    return "";
  }

  prepare<BindParameters extends unknown[] = any[], ResultValue = any>(
    sql: string,
  ): Database.Statement<BindParameters, ResultValue> {
    return new AdapterStatement(this.db.query(sql)) as unknown as Database.Statement<
      BindParameters,
      ResultValue
    >;
  }

  exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  /** better-sqlite3 semantics: write pragmas return their result rows
   *  too (e.g. journal_mode), reads return rows, and { simple: true }
   *  returns the first column of the first row. */
  pragma(sql: string, options: { simple?: boolean } = {}): any {
    const rows = (this.db.query(`PRAGMA ${sql}`).all() as Record<string, unknown>[]).map(
      (row) => convertRow(row) as Record<string, unknown>,
    );
    if (options.simple) {
      if (!rows.length) return undefined;
      return Object.values(rows[0]!)[0];
    }
    return rows;
  }

  transaction<F extends (...args: any[]) => any>(fn: F): Database.Transaction<F> {
    const build = (mode: "deferred" | "immediate" | "exclusive") =>
      ((...args: any[]) => this.runInTransaction(mode, () => fn(...args))) as any;
    const deferred = build("deferred");
    const immediate = build("immediate");
    const exclusive = build("exclusive");
    for (const w of [deferred, immediate, exclusive]) {
      w.deferred = deferred;
      w.immediate = immediate;
      w.exclusive = exclusive;
      w.default = deferred;
    }
    return deferred as Database.Transaction<F>;
  }

  private runInTransaction<R>(mode: "deferred" | "immediate" | "exclusive", fn: () => R): R {
    const db = this.db as any;
    if (this.txDepth === 0 && !db.inTransaction) {
      db.exec(mode === "deferred" ? "BEGIN" : `BEGIN ${mode.toUpperCase()}`);
      this.txDepth++;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // keep the original error
        }
        throw err;
      } finally {
        this.txDepth--;
      }
    }
    // Nested transaction (or a caller-managed BEGIN is open): savepoint.
    const name = `odbun_sp_${this.txDepth}`;
    db.exec(`SAVEPOINT ${name}`);
    this.txDepth++;
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      try {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      } catch {
        // keep the original error
      }
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  /** bun:sqlite supports extension loading natively; delegate. */
  loadExtension(path: string, entrypoint?: string): this {
    (this.db as any).loadExtension(path, entrypoint);
    return this;
  }

  /** Serialize the database to bytes (bun:sqlite native). Returned as
   *  a Buffer, matching better-sqlite3's serialize(). */
  serialize(): Buffer {
    return Buffer.from((this.db as any).serialize() as Uint8Array);
  }

  close(): this {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
    return this;
  }
}

export namespace Database {
  export interface Options {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
    verbose?: ((message?: unknown, ...additionalArgs: unknown[]) => void) | null;
    nativeBinding?: string;
  }

  export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface ColumnDefinition {
    name: string;
    column: string | null;
    table: string | null;
    database: string | null;
    type: string | null;
  }

  export interface Statement<BindParameters extends unknown[] = any[], ResultValue = any> {
    run(...params: BindParameters): RunResult;
    get(...params: BindParameters): ResultValue | undefined;
    all(...params: BindParameters): ResultValue[];
    iterate(...params: BindParameters): IterableIterator<ResultValue>;
    raw(toggleState?: boolean): Statement<BindParameters, ResultValue>;
    pluck(toggleState?: boolean): Statement<BindParameters, ResultValue>;
    expand(toggleState?: boolean): Statement<BindParameters, ResultValue>;
    bind(...params: unknown[]): Statement<BindParameters, ResultValue>;
    columns(): ColumnDefinition[];
    safeIntegers(toggleState?: boolean): Statement<BindParameters, ResultValue>;
  }

  export interface Transaction<F extends (...args: any[]) => any> {
    (...args: Parameters<F>): ReturnType<F>;
    default: Transaction<F>;
    deferred: Transaction<F>;
    immediate: Transaction<F>;
    exclusive: Transaction<F>;
  }

  /** The instance type — what `Database.Database` means at call sites
   *  that imported the default export as a type. */
  export type Database = InstanceType<typeof import("./db.js").Database>;
}

export default Database;
