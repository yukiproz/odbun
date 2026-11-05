# BUN-TECH — Bun 1.4.x technology ledger for the odbun port

Date: 2026-11-05 · Bun on Hadi's machine: **1.4.4** (verified live in
this room) · Port: `odbun` — standalone Bun-native port of OpenDesign
(not bound to the parent project or its CI).

**Provenance — not from memory.** This ledger was produced by re-reading
the parent project's `BUN-14X-FEATURES.md` in full today (that document
itself rests on live tests of 2026-11-05 in the parent project, with
official Bun references), then **re-mapping every entry to this port's
own decisions**. Where the port's status differs from the parent CI's,
the difference is stated explicitly — the parent CI is hybrid
(Bun builds, Node runs); this port drops Node, so several verdicts flip.
Live evidence gathered in *this* room today: `bun test` 11/11 PASS on
Hadi's machine, all four runtime spikes PASS (sqlite / spawn / serve /
terminal-PTY).

## 1. Version line 1.4.x (what each release brings this port)

| Version | Relevant content |
|---|---|
| 1.4.0 | Platform release: Zig→Rust rewrite; pnpm-parity package-manager pack (`dedupe`, `prune`, `pm licenses`, `audit fix`, `--filter`, `--catalog`, nested overrides); `bun run/test --parallel`; `Bun.Image`, `Bun.WebView`, `Bun.markdown`, `Bun.cron()`, `Bun.Terminal` |
| 1.4.1 | `Bun.serve` HTTP/2 + WebSocket `pause()`/`resume()` backpressure; lower idle memory; better HTML-entrypoint bundling |
| 1.4.2 | Fixes only |
| 1.4.3 | `bun check` — built-in TypeScript type checker (typescript-go port); `--check` flag for `run`/`test`/`build` |
| 1.4.4 | `bun fmt` (Prettier-compatible formatter); `bun check` 1.4–7.8× faster; install fixes |

Caution carried over (live-probed 2026-10-30, **re-probed in this room
2026-11-05**: `bun lint` → `error: Script not found "lint"`): current
Bun docs mention `bun lint`, but that command **does not exist in
1.4.4** — do not assume it on this machine.

## 2. Runtime APIs — ADOPTED in this port (with live proof)

| Bun tech | Used for | Where | Proof |
|---|---|---|---|
| `bun:sqlite` (`Database`) | **The** database — replaces better-sqlite3 outright | `runtime/db/bun-sqlite.ts` + `better-sqlite3-shim.ts` | tests/db.test.ts (6 tests) + spikes/01 PASS on Hadi's machine |
| `Bun.spawn` | All process spawning — replaces `child_process`; carries OpenCode v2's directory contract via child `PWD` env + cwd | `runtime/proc/bun-spawn.ts` | tests/spawn.test.ts (3 tests) + spikes/02 PASS |
| `Bun.Terminal` (1.4.0) | PTY — replaces node-pty | `runtime/pty/bun-terminal.ts` | spikes/04 PASS on Hadi's machine (PTY echo round-trip). NOTE: was only a *candidate* in the parent doc, unusable there because the parent daemon runs on Node — in this port it is adopted and proven. Trap found today: an open PTY holds the event loop; the adapter has an explicit `close()` |
| `Bun.serve` (HTTP/2, 1.4.1) | Smoke-gate probe for health + static serving; pattern for any future re-plumb of the daemon's static serving | `runtime/http/bun-serve.ts` | tests/serve.test.ts (2 tests) + spikes/03 PASS |
| Bun native `fetch` | All HTTP client work — replaces undici (deleted, incl. its Socks5 gap) | `runtime/fetch/native-fetch.ts` | serve tests exercise it end-to-end |
| `Bun.file` | Static file serving in the probe | `runtime/http/bun-serve.ts` | serve tests |

## 3. CLI / package-manager tech — ADOPTED (port's own build, when built)

| Tech | Used for | Note vs parent CI |
|---|---|---|
| `bun install --filter` | Web-closure install; cut node_modules 2.5 GB → 1.6 GB in the parent's measurements and removed the desktop packaging chain | Same adoption, port's own choice |
| `bun dedupe --check` | Duplicate-version lint on `bun.lock` (±40 ms, 1,369 pkgs measured) | Scope honesty from the parent's audit: it checks *duplicates only* — lock↔manifest fidelity is a separate check |
| `bun check` | Fast typecheck gate (measured 1.1 s vs `tsc` 3.4 s on `apps/daemon`, identical errors) | Gate *in addition* — it emits nothing, `tsc` still produces `.d.ts` in the build |
| `bun audit` | Informational vulnerability summary in the receipt (parent measurement: 225 vuln, 6 critical) | Never auto-fixed |
| `bun run` | Script executor for every build step | Trap (proven): `bun --cwd <abs> run <script>` prints usage and exits 0 doing nothing — always `cd` + `bun run`, and verify `dist/` exists |
| `bun pm untrusted` | Triage of install scripts held back by `--ignore-scripts` | Diagnostic, not a gate; in this port the native-addon list shrinks (no better-sqlite3/node-pty to rebuild) |
| **`bun test`** | **Test runner for the port's OWN code** (adapters, spikes' assertions) | ⚠️ **Flips the parent verdict.** Parent rejected it because the *upstream* suite is Vitest/jsdom — that remains true for upstream's suite (not a drop-in replacement, and this ledger does not claim otherwise). For code this port authors, `bun test` is the runner: 11/11 PASS today |

## 4. REJECTED — with reasons (re judged for this port, not inherited)

| Tech | Verdict for odbun |
|---|---|
| `bun run --filter/--workspaces --parallel` as the build engine | Rejected for now, same evidence as parent: upstream's `postinstall.mjs` graph is the proven topological order. Bun docs now claim `--filter` respects workspace dependency order — flagged for re-evaluation, not adopted silently |
| `bun prune --production` | Rejected: build needs devDependencies (`tsc`, `next`) |
| `bun audit fix` / automatic `bun update` | Rejected: silently moving dependency inputs is wrong for a port that must stay diffable against its upstream base |
| `bun fmt` | Not adopted: upstream-derived files keep upstream style; revisiting for port-authored files only is Hadi's call |
| `bun install --frozen-lockfile` | ⚠️ **Status CHANGED vs parent.** Parent rejected it because its rsync folder-2 pattern restores a pristine manifest that fights a kept lockfile. This port is a standalone tree (`odbun/`) with its own manifest + lockfile and no rsync-pristine pattern, so the parent's evidence does **not** apply here. Verdict: **ADOPTED (2026-11-06)** — frozen installs pass on merged main (FINAL-VERIFY §1: 1,013 pkgs, zero drift) and the CI typecheck/smoke jobs run frozen; requirement: bun-migrated manifest + bun.lock committed as one unit |

## 5. Candidates — recorded, not yet used

- `bun pm diff` — read source diffs of key packages across version bumps of the upstream base.
- `bun outdated --filter` — dependency drift watch on the web closure only.
- `bun pm licenses` — license report; matters if odbun is ever distributed (pairs with the attribution question for the port).
- `minimumReleaseAge` (bunfig) — supply-chain cooling-off for newly published packages; changes resolution behaviour, so it is Hadi's decision, not a default.
- `bun build --check` / `Bun.build({ check: true })` — for the port's own tooling scripts.
- `bun run --parallel` — parallel helper scripts outside the build graph.
- `bun build --compile` — single-binary distribution of the port's launcher later; not needed while `odbun` shim + `bun` exist on the machine.
- Evaluated, no use found in this port today: `Bun.Image`, `Bun.WebView`, `Bun.markdown`, `Bun.cron()` (the daemon has its own automation/scheduling concepts; do not double-schedule).

## 6. Design limits of 1.4.4 that shape this port

- `better-sqlite3` cannot load in Bun (`ERR_DLOPEN_FAILED`,
  oven-sh/bun#4290) — the parent treats this as the reason to keep
  Node; **this port treats it as the reason R1 exists** (`bun:sqlite`
  adapter). Same fact, opposite conclusion — that is the radical
  decision of 2026-11-05.
- Bun's bundled undici lacks `Socks5ProxyAgent` — irrelevant here:
  undici is deleted (R4), native fetch is the client.
- Every Bun release > 1.4.4: re-check #4290 and this ledger's traps
  before raising the 1.4.x gate.

## References (official, as verified for the parent document)

- Bun 1.4 blog: https://bun.com/blog/bun-v1.4 · v1.4.3 (`bun check`): https://bun.com/blog/bun-v1.4.3 · v1.4.4: https://bun.com/blog/bun-v1.4.4
- pnpm-parity PR #38333: https://github.com/oven-sh/bun/pull/38333
- Docs: filter https://bun.com/docs/pm/filter · install https://bun.com/docs/pm/cli/install.md · dedupe https://bun.com/docs/pm/cli/dedupe.md · prune https://bun.com/docs/pm/cli/prune.md · audit https://bun.com/docs/pm/cli/audit.md · type checking https://bun.com/docs/runtime/check
