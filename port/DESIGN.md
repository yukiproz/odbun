# DESIGN — Radical Bun-native architecture

## 1. What "drop Node" actually means here

No Node binary is executed at install, build, runtime, or smoke time.
Bun 1.4.4 is the only runtime. Bun's own `node:*` compatibility layer may
still be *loaded* by upstream code paths we have not yet replaced — that
is a transitional fact, tracked per-module below, not a design goal. The
goal state: every hot/blocking Node dependency is replaced by a Bun
native API, and the remaining compat surface is inert glue (path, os,
crypto) with no native-addon and no Node process anywhere.

**Honesty gate.** The parent CI exists in hybrid form precisely because
the daemon cannot boot in Bun today: `better-sqlite3` is a native addon
Bun refuses to dlopen (oven-sh/bun#4290), and `node-pty` is the second
native addon. This variant does not wish that away — it removes both
addons (R1, R2) and must then *prove* boot + acceptance (§5) before the
word "works" is used. Until then: scaffold.

## 2. Node surface census (folder-1, v0.27.0, measured 2026-11-05)

Read-only census of `apps/daemon/src` (782 `.ts` files):

| Surface | Files | Hits | Concentration |
|---|---|---|---|
| `better-sqlite3` | 104 | 109 | Mostly `import type` — runtime construction is concentrated (`storage/daemon-db.ts`, `db.ts` 6,007 lines, a few direct `new Database` sites e.g. `codex-archived-rollout-index.ts`, `transcript-export.ts`, `storage/diagnostic-outbox.ts`) |
| DB call sites | — | `prepare` 615, `exec` 394, `transaction` 82, `pragma` 12 | The adapter must cover exactly this surface first |
| `node-pty` | 4 | 13 | Isolated behind `services/node-pty.ts` + `terminals.ts` — one seam |
| `child_process` (`node:` + bare) | 42 | 52 | OpenCode/agent spawning, git, media tools |
| `undici` | 5 | 17 | Connection test / proxy — dropped with native fetch |
| `node:http` | 4 | 5 | Server is Express: `server.ts` (18,961 lines) `express()` + `app.listen` |
| `node:fs` / `node:path` / `node:crypto` / `node:os` | 202 / 219 / 139 / 47 | — | Compat-layer glue; Bun implements these — replace opportunistically, not a blocker |

## 3. Replacement matrix (the R-patches)

| ID | Replaces | Bun native | Strategy |
|---|---|---|---|
| R1 | `better-sqlite3` | `bun:sqlite` (`Database`) | Import-rewrite patch: daemon imports of `better-sqlite3` point at `runtime/db/better-sqlite3-shim.ts`, which re-exports the adapter in `runtime/db/bun-sqlite.ts`. Adapter implements the measured surface: `prepare().run/get/all/iterate`, `exec`, `pragma`, `transaction`, `close`, readonly/fileMustExist/timeout options honoured or loudly rejected. Existing on-disk DBs are plain SQLite files — `bun:sqlite` opens the same format, so `data-od-bun/` can start empty or copy `data/` for A/B. |
| R2 | `node-pty` | `Bun.spawn` + `Bun.Terminal` (Bun 1.4) | Single seam: replace the loader in `services/node-pty.ts` with `runtime/pty/bun-terminal.ts` exposing the spawn/onData/write/resize/kill surface `terminals.ts` consumes. **Spike-gated** (spikes/04) — PTY is the least-proven Bun surface here. |
| R3 | `child_process` | `Bun.spawn` | Hot paths first: agent runtimes (OpenCode invocation must carry the directory via child `PWD` env + cwd — the v2 contract from the seed brief P1). `runtime/proc/bun-spawn.ts` is the canonical helper. Long tail of 42 files migrates behind the same helper or Bun's `node:child_process` compat until replaced. |
| R4 | `undici` (+ parent Socks5 patch) | native `fetch` | Delete, don't port. Bun fetch covers the connection-test path; proxy support comes from Bun fetch options/env. The parent's `undici-socks5.patch.tmpl` has no counterpart here. |
| R5 | Express/`node:http` boot & smoke | Bun runtime first; `Bun.serve` where the daemon's own server is re-plumbed | Two steps: (a) boot the existing Express app **under Bun** (Bun can run it; this already satisfies "no Node binary"), (b) optionally re-plumb static/health serving to `Bun.serve` (`runtime/http/bun-serve.ts` is the probe used by the smoke gate). Step (b) is an optimisation, not a boot blocker — do not let it gate R1–R4. |

Plus the seed-brief patches, unchanged in intent, v2-only where decided:

- **P1** OpenCode def → v2 dialect (no `--dir`/`--pure`, `session export`,
  `-m provider/model#variant`, `--dangerously-skip-permissions` passed
  through as-is).
- **P2** Reasoning-variant discovery via one-shot `opencode serve --stdio`
  + `GET /api/model` (spawned via R3's helper).
- **P3** MCP injection emits **v2 only**: `{"mcp": {"servers": {…}}}`,
  `disabled` instead of `enabled`.
- **P4** Permission grants emit **v2 only**: `permissions` ordered ruleset
  `[{action, resource, effect}]`, last-match-wins, deny last.
- **P5** Delete-project fully local = backport of upstream PR #8927
  (issue #8926); drop the patch when upstream ships the fix.

Out of scope (upstream design, do not fake): the OpenCode event-plugin
live-preview gate (v1-only by upstream's own check).

## 4. Pipeline deltas vs parent CI-BUN

Inherited as-is: no version pinning (latest `open-design-v*` tag, manual
run = the check, skip on identical SHA + tree-hash, `FORCE=1` override),
web-only filtered install, patch application **only** on the build copy,
tree-hash artifact integrity, per-SHA receipt snapshots, breaking
categories with `BREAKING-REPORT.md`.

Changed:

1. Stage 0 preflight checks **Bun 1.4.x only** — the Node ~24 check is
   deleted; finding `node` in any stage is itself a breaking category
   (`node-invocation-found`).
2. New stage after mirror: **apply patch set** (`patches/manifest.json`
   order: P-patches, then R-patches; R4 supersedes the parent undici
   stage, which is removed).
3. Native rebuild stage (better-sqlite3/node-pty) is **deleted** — there
   are no native addons left to rebuild. In its place: **adapter gate** —
   `bun test` (this folder's suite) + the four spikes must pass against
   the built tree.
4. Smoke gate runs the daemon **with bun**: `bun apps/daemon/dist/cli.js
   --no-open --port 7457`, `OD_DATA_DIR=<project>/data-od-bun`, health
   `GET /api/health` must return 200 `{"ok":true,…}` and `/` must serve
   this run's web chunks (same hardening as parent v4: free port first,
   own process group, kill by PGID).
5. Receipt adds: `"runtime": "bun"`, `"node": false`,
   `"patchSet": [{id, file, sha256}]`, `"dataDir": "data-od-bun"`,
   `"port": 7457`, `"shim": "odbun"`.
6. Shim `odbun`: sets `OD_DATA_DIR=…/data-od-bun`, default port 7457,
   `OPENCODE_BIN` points at the **real** OpenCode v2 binary (no
   translator wrapper — P1–P4 make the daemon speak v2 itself), then
   `exec bun …/odbun/apps/daemon/bin/od.mjs`.

## 5. Acceptance (definition of done, per area)

- **Boot**: daemon built by this pipeline answers `/api/health` under
  Bun with `data-od-bun/`; no `node` process appears at any point
  (`ps` evidence in the run report).
- **DB**: daemon opens a copied pristine `app.sqlite` under
  `bun:sqlite`; project list + one conversation load identically to the
  pristine build (A/B against `od` on 7456).
- **P1+P2 / P3 / P4 / P5**: exactly the seed brief §6 tests, run against
  the native build on port 7457.
- **PTY**: interactive terminal session in the web UI spawns, echoes,
  resizes, and exits cleanly via the R2 adapter.
- **Patch hygiene**: every upstream release bump re-applies the set;
  a patch that no longer applies is a first-class breaking category,
  never a reason to edit folder-1. Patches whose upstream equivalent
  lands (#9121, #8927) are removed and the removal is recorded —
  theoretical end state is an empty patch set plus the R-adapters,
  which shrink as Bun compat grows.

## 6. Risks, stated plainly

- `bun:sqlite` is synchronous like better-sqlite3 — good — but its
  statement/transaction edge semantics differ in places; the adapter
  tests are the contract, and daemon DB behaviour must A/B against
  pristine before `data-od-bun/` is trusted with real projects.
- Bun PTY (`Bun.Terminal`) is new in the 1.4 line; if spike 04 fails,
  R2 is the one place a fallback may be *discussed* with Hadi — never
  smuggled in (no silent Node, no silent node-pty).
- Next.js web build under Bun-only: the parent already builds
  `apps/web` with `bun run build` (Next invokes its own tooling as
  libraries, not a Node binary we call) — verify no stage shells out to
  `node` explicitly; if Next's build does internally, that is recorded
  as a known compat exception for Hadi to judge, not hidden.
