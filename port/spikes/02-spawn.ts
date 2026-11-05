// Spike 02 — Bun.spawn + the OpenCode v2 PWD contract (R3/P1).
// Run: bun run spikes/02-spawn.ts   (expect: PASS + exit 0)
import { spawnCapture } from "../runtime/proc/bun-spawn.ts";

const r = await spawnCapture(["bash", "-c", "echo cwd=$PWD"], { cwd: "/tmp" });
if (r.exitCode !== 0 || !r.stdout.includes("cwd=/tmp")) {
  console.error("FAIL:", r);
  process.exit(1);
}
console.log("SPIKE 02 spawn: PASS (Bun.spawn, PWD env carries cwd)");
