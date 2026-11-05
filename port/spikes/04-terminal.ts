// Spike 04 — Bun.Terminal PTY (R2 gate). This is the least-proven Bun
// surface in the design, so the spike is honest about its outcome:
//   PASS  — a PTY session echoed output end-to-end
//   SKIP  — Bun.Terminal unavailable here (R2 stays blocked; report,
//           never fall back to node-pty/Node)
// Run: bun run spikes/04-terminal.ts

import { ptySupported, spawnPty } from "../runtime/pty/bun-terminal.ts";

if (!ptySupported()) {
  console.log("SPIKE 04 terminal: SKIP (Bun.Terminal unavailable in this Bun build)");
  process.exit(0);
}

let seen = "";
let handle: ReturnType<typeof spawnPty> | undefined;
const done = new Promise<void>((resolve) => {
  const pty = spawnPty("bash", ["--noprofile", "--norc"], {
    cols: 80,
    rows: 24,
    onData(text) {
      seen += text;
      if (seen.includes("PTY_OK")) resolve();
    },
  });
  handle = pty;
  pty.write("echo PTY_OK\n");
  setTimeout(() => pty.write("exit\n"), 250);
});

const timeout = new Promise<"timeout">((resolve) =>
  setTimeout(() => resolve("timeout"), 5000),
);
const winner = await Promise.race([done.then(() => "done" as const), timeout]);
// An open PTY keeps the event loop alive even after the child exits —
// close the terminal explicitly, then exit with the verdict.
try {
  handle?.kill();
  handle?.close();
} catch {}
if (winner === "done") {
  console.log("SPIKE 04 terminal: PASS (Bun.Terminal PTY echo round-trip)");
  process.exit(0);
} else {
  console.log("SPIKE 04 terminal: FAIL (no PTY_OK within 5s) — R2 blocked, report to Hadi");
  process.exit(1);
}
