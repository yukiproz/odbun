// Spike 01 — bun:sqlite through the adapter: the R1 feasibility proof.
// Run: bun run spikes/01-sqlite.ts   (expect: PASS + exit 0)
import { BunSqliteDatabase } from "../runtime/db/bun-sqlite.ts";

const db = new BunSqliteDatabase(":memory:");
db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT)");
const add = db.transaction((id: string, title: string) => {
  db.prepare("INSERT INTO projects VALUES (?, ?)").run(id, title);
});
add("p1", "Alpha");
add("p2", "Beta");
const rows = db.prepare("SELECT title FROM projects ORDER BY id").all() as any[];
if (rows.length !== 2 || rows[0].title !== "Alpha") {
  console.error("FAIL: unexpected rows", rows);
  process.exit(1);
}
db.close();
console.log("SPIKE 01 sqlite: PASS (bun:sqlite via adapter, transaction + prepare + all)");
