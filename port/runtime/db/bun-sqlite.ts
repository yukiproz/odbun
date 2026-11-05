// R1 — bun:sqlite adapter presenting the better-sqlite3 surface the
// OpenDesign daemon actually uses (measured 2026-11-05, folder-1 v0.27.0:
// prepare 615 call sites, exec 394, transaction 82, pragma 12).
//
// This is the contract, not a full better-sqlite3 clone. Options or
// statement modes the adapter does not support throw loudly instead of
// silently behaving differently — a quiet wrong answer from the DB
// layer is worse than a crash.

import { Database as BunDatabase } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface BunSqliteOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  timeout?: number; // ms — mapped to PRAGMA busy_timeout
  create?: boolean;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

type Params = unknown[];

class AdapterStatement {
  private rawMode = false;
  constructor(private stmt: any) {}

  raw(mode = true): this {
    this.rawMode = mode;
    return this;
  }
  // pluck/expand are presentation toggles we do not implement yet.
  pluck(): this {
    throw new Error("bun-sqlite adapter: .pluck() not implemented yet");
  }
  expand(): this {
    throw new Error("bun-sqlite adapter: .expand() not implemented yet");
  }

  run(...params: Params): RunResult {
    const r = this.stmt.run(...params);
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }
  get(...params: Params): unknown {
    if (this.rawMode) {
      const rows = this.stmt.values(...params);
      return rows.length ? rows[0] : undefined;
    }
    const row = this.stmt.get(...params);
    return row === null ? undefined : row;
  }
  all(...params: Params): unknown[] {
    if (this.rawMode) return this.stmt.values(...params);
    return this.stmt.all(...params);
  }
  *iterate(...params: Params): IterableIterator<unknown> {
    if (typeof this.stmt.iterate === "function") {
      yield* this.stmt.iterate(...params);
    } else {
      yield* this.all(...params);
    }
  }
}

export class BunSqliteDatabase {
  private db: BunDatabase;
  private closed = false;

  constructor(path: string, options: BunSqliteOptions = {}) {
    if (options.fileMustExist && path !== ":memory:" && !existsSync(path)) {
      throw new Error(`bun-sqlite adapter: fileMustExist but no such file: ${path}`);
    }
    this.db = new BunDatabase(path, {
      create: options.create ?? !options.readonly,
      readonly: options.readonly ?? false,
    });
    if (options.timeout && options.timeout > 0) {
      this.db.exec(`PRAGMA busy_timeout = ${Math.floor(options.timeout)}`);
    }
  }

  get open(): boolean {
    return !this.closed;
  }
  get name(): string {
    return "";
  }

  prepare(sql: string): AdapterStatement {
    return new AdapterStatement(this.db.query(sql));
  }

  exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  /** better-sqlite3: pragma('key') reads, pragma('key = v') writes,
   *  { simple: true } returns the first column of the first row. */
  pragma(sql: string, options: { simple?: boolean } = {}): unknown {
    const stmt: any = this.db.query(`PRAGMA ${sql}`);
    if (sql.includes("=")) {
      stmt.run();
      return undefined;
    }
    if (options.simple) {
      const row = stmt.get() as Record<string, unknown> | null;
      if (!row) return undefined;
      return Object.values(row)[0];
    }
    return stmt.all();
  }

  /** Returns a function that runs fn inside a transaction
   *  (bun:sqlite's own transaction helper — deferred by default). */
  transaction<T extends (...args: any[]) => any>(fn: T): T {
    const tx = (this.db as any).transaction(fn);
    return ((...args: any[]) => tx(...args)) as T;
  }

  close(): this {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
    return this;
  }
}

export default BunSqliteDatabase;
