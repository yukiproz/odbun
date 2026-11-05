import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveProbe } from "../runtime/http/bun-serve.ts";

const dir = mkdtempSync(join(tmpdir(), "od-native-static-"));
writeFileSync(join(dir, "index.html"), "<html>native-probe</html>");

let server: ReturnType<typeof serveProbe>;
beforeAll(() => {
  server = serveProbe({ port: 0, staticDir: dir });
});
afterAll(() => server.stop());

describe("Bun.serve probe", () => {
  test("/api/health answers ok with runtime bun", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.runtime).toBe("bun");
  });

  test("static index is served", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("native-probe");
  });
});
