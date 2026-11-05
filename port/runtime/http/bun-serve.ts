// R5 — Bun.serve probe used by the native smoke gate: serves the web
// build's static output and answers /api/health the way the daemon
// must. This is a gate/probe (and the pattern for any future Bun.serve
// re-plumb of the daemon's static serving) — the daemon's own Express
// app still boots under Bun for R5 step (a); see DESIGN.md §3 R5.

import { join } from "node:path";

export interface ServeProbeOptions {
  port: number;
  staticDir: string;
  hostname?: string;
}

export function serveProbe(opts: ServeProbeOptions) {
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/health") {
        return Response.json({ ok: true, runtime: "bun" });
      }
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = Bun.file(join(opts.staticDir, rel));
      if (await file.exists()) return new Response(file);
      const index = Bun.file(join(opts.staticDir, "index.html"));
      if (await index.exists()) return new Response(index);
      return new Response("not found", { status: 404 });
    },
  });
  return {
    port: server.port,
    stop() {
      server.stop(true);
    },
  };
}
