# PORTING — work checklist for odbun

How porting works in this repo: **direct edits with ordinary commits**
on top of the v0.27.0 base import. There is no patch-application stage
and no external build pipeline — the repo is the port. Each item below
lands as its own commit (or small series) with its acceptance check
run and recorded. Registry with statuses: `port/port-items.json`.
Architecture and rationale: `port/DESIGN.md`. Bun tech ledger:
`port/BUN-TECH.md`.

## Radical replacements (R)

- [ ] **R1 — DB**: rewrite daemon `better-sqlite3` imports to the
  `bun:sqlite` adapter (`port/runtime/db/`); remove the dependency.
  Surface to cover (measured): prepare 615, exec 394, transaction 82,
  pragma 12 call sites. Acceptance: adapter tests green + daemon opens
  a real `app.sqlite` copy and serves project/conversation reads.
- [ ] **R2 — PTY**: replace the `services/node-pty.ts` seam with the
  `Bun.Terminal` adapter (`port/runtime/pty/`); remove node-pty.
  Spike 04 already passes; acceptance is an interactive terminal
  session in the web UI (spawn, echo, resize, clean exit).
- [ ] **R3 — Spawn**: migrate `child_process` call sites (42 files;
  agent runtimes first) to `port/runtime/proc/bun-spawn.ts`
  (Bun.spawn, `PWD`-env directory contract).
- [ ] **R4 — Fetch**: remove undici; connection test on native fetch.
- [ ] **R5 — Serve**: boot the daemon (Express app) under Bun; then
  optionally re-plumb static/health serving to `Bun.serve`
  (`port/runtime/http/` is the proven probe). Optional step must not
  gate R1–R4.

## OpenCode v2 native (P1–P4, v2-only)

- [ ] **P1** Runtime def speaks v2: no `--dir` (PWD env + cwd), no
  `--pure`, `session export`, `-m provider/model#variant`,
  `--dangerously-skip-permissions` passed through.
- [ ] **P2** Reasoning-variant discovery via one-shot
  `opencode serve --stdio` + `GET /api/model`; graceful fallback to
  plain model ids.
- [ ] **P3** MCP injection emits v2 only: `{"mcp": {"servers": {…}}}`,
  `disabled` not `enabled`.
- [ ] **P4** Permission grants emit v2 only: ordered `permissions`
  ruleset `[{action, resource, effect}]`, last-match-wins, deny last.

## Fully-local behaviour (P5)

- [ ] **P5** Project delete works signed-out / fully local (upstream
  issue #8926; if upstream's fix PR #8927 has landed in a later base
  we rebase onto, this item closes by rebase instead of by edit).

## Build & runtime migration

- [ ] Root workspace: migrate `packageManager`/lockfile from pnpm to
  Bun (`bun install --filter` web closure; evaluate
  `--frozen-lockfile` for this standalone tree — see BUN-TECH §4).
- [ ] Build web closure + daemon with Bun only; no `node` invocation
  anywhere (CI greps for it).
- [ ] Smoke gate in CI: daemon under `bun`, `OD_DATA_DIR` pointing at a
  throwaway dir, port 7457, `/api/health` 200, `/` serves this build's
  web chunks; no Node process involved.
- [ ] End-user install shape: `odbun` shim (template:
  `port/odbun-shim`) + `data-od-bun/` — Hadi installs the finished
  build; development and CI live in this repo on the VM + GitHub
  Actions.

## Out of scope (by decision)

Desktop/Electron, packaged builds, upstream's own CI topology, and any
Node-compat fallback lane. If a Bun surface genuinely cannot carry a
feature yet, the item stays open and reported — it is never silently
routed back to Node.
