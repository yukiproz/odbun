// Spike 03 — Bun.serve health + static probe (R5 smoke-gate pattern).
// Run: bun run spikes/03-serve.ts   (expect: PASS + exit 0)
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveProbe } from "../runtime/http/bun-serve.ts";

const dir = mkdtempSync(join(tmpdir(), "od-native-spike-"));
writeFileSync(join(dir, "index.html"), "<html>spike</html>");
const server = serveProbe({ port: 0, staticDir: dir });
try {
  const health = await fetch(`http://127.0.0.1:${server.port}/api/health`);
  const body = (await health.json()) as any;
  const home = await fetch(`http://127.0.0.1:${server.port}/`);
  const text = await home.text();
  if (!body.ok || body.runtime !== "bun" || !text.includes("spike")) {
    console.error("FAIL:", body, text);
    process.exit(1);
  }
  console.log(`SPIKE 03 serve: PASS (Bun.serve on port ${server.port}, health + static)`);
} finally {
  server.stop();
}
