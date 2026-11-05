import { describe, expect, test } from "bun:test";
import { BunSqliteDatabase } from "../runtime/db/bun-sqlite.ts";
import Database from "../runtime/db/better-sqlite3-shim.ts";

describe("bun:sqlite adapter (better-sqlite3 surface)", () => {
  test("CRUD via prepare run/get/all", () => {
    const db = new BunSqliteDatabase(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const ins = db.prepare("INSERT INTO t (name) VALUES (?)");
    const r1 = ins.run("alpha");
    expect(r1.changes).toBe(1);
    expect(Number(r1.lastInsertRowid)).toBe(1);
    ins.run("beta");
    expect((db.prepare("SELECT COUNT(*) AS c FROM t").get() as any).c).toBe(2);
    const rows = db.prepare("SELECT name FROM t ORDER BY id").all() as any[];
    expect(rows.map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(db.prepare("SELECT name FROM t WHERE id = ?").get(99)).toBeUndefined();
    db.close();
    expect(db.open).toBe(false);
  });

  test("pragma simple + exec multi-statement", () => {
    const db = new BunSqliteDatabase(":memory:");
    db.exec("CREATE TABLE a (x); CREATE TABLE b (y);");
    db.pragma("journal_mode = WAL");
    expect(typeof db.pragma("busy_timeout", { simple: true })).toBe("number");
    db.close();
  });

  test("transaction commits and rolls back", () => {
    const db = new BunSqliteDatabase(":memory:");
    db.exec("CREATE TABLE t (v TEXT)");
    const add = db.transaction((v: string) => {
      db.prepare("INSERT INTO t VALUES (?)").run(v);
    });
    add("ok");
    const failing = db.transaction(() => {
      db.prepare("INSERT INTO t VALUES ('bad')").run();
      throw new Error("boom");
    });
    expect(() => failing()).toThrow("boom");
    const vals = (db.prepare("SELECT v FROM t").all() as any[]).map((r) => r.v);
    expect(vals).toEqual(["ok"]);
    db.close();
  });

  test("fileMustExist is honoured; shim default export constructs", () => {
    expect(
      () => new BunSqliteDatabase("/tmp/od-native-definitely-missing.sqlite", { fileMustExist: true }),
    ).toThrow("fileMustExist");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE s (x)");
    db.close();
  });

  test("raw mode returns arrays", () => {
    const db = new BunSqliteDatabase(":memory:");
    db.exec("CREATE TABLE t (a, b); INSERT INTO t VALUES (1, 'x')");
    const row = db.prepare("SELECT a, b FROM t").raw().get();
    expect(row).toEqual([1, "x"]);
    db.close();
  });

  test("iterate yields all rows", () => {
    const db = new BunSqliteDatabase(":memory:");
    db.exec("CREATE TABLE t (n); INSERT INTO t VALUES (1), (2), (3)");
    const ns = [...db.prepare("SELECT n FROM t ORDER BY n").iterate()].map(
      (r: any) => r.n,
    );
    expect(ns).toEqual([1, 2, 3]);
    db.close();
  });
});
