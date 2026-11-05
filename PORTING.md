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

## Update policy — upstream is a vendor base, not a master (Hadi, 2026-11-05)

odbun does **not** chase every upstream release. Staying on the
v0.27.0 base for a long time is acceptable and expected. Three
escalating responses, cheapest first:

1. **Stay** — default. Nothing happens per upstream release.
2. **Cherry-pick** — a single upstream fix we actually need (security,
   or a bug we hit) is cherry-picked onto our `main` without a full
   version merge.
3. **Full merge** — rare and deliberate, only when upstream brings a
   security fix set, a feature we want, or a fix that retires port
   items (#9121, #8927). Done on an `update/*` branch, CI must be
   green, and `data-od-bun/` is snapshotted first because schema
   migrations may ride along.

odbun carries its **own version line**; the base version is recorded
alongside it (e.g. "odbun 0.1.0 · base open-design v0.27.0"), never
implied to track upstream numbering.

## Extensions — custom providers & extra mechanisms (planned, Hadi, 2026-11-05)

Custom providers and other non-default mechanisms are expected in
this port's future. House rule so they stay cheap to keep:

- **New files + one registration point.** A custom provider is a new
  runtime def following upstream's `RuntimeAgentDef` contract,
  registered at the single place upstream registers defs — not edits
  scattered through upstream code. Same shape for other mechanisms:
  own module under `port/` (or an `odbun`-namespaced package), wired
  in at one hook point.
- **Namespaced config** (`odbun.*` keys / `ODBUN_*` env), so an
  upstream config change never collides with ours.
- **Every divergence is registered** in `port/port-items.json` with
  its reason. The explicit delta list is what makes infrequent
  updates safe: we always know exactly what we own.

## Out of scope (by decision)

Desktop/Electron, packaged builds, upstream's own CI topology, and any
Node-compat fallback lane.

**Parked features — Vela (Hadi, 2026-11-06).** Upstream's team/cloud
integration (the external Vela CLI: collab adapters, the AMR runtime
binary, login/billing/team-projects/share) is not carried by odbun's
local/single-user web scope. It is *parked*, not removed — the
production code stays in tree, dormant and untouched (it is rooted in
122 src files; removal was rejected), and only its test suites are
excluded, on both CI tracks, via
`apps/daemon/tests/parked-features.json`. Registered as item **V1**
in `port/port-items.json`; census and rationale in
`port/TEST-SUITES.md` §8. A future decision to carry team features
unparks it by deleting the manifest entries.

**Docker — drop only if it gets in the way (Hadi, 2026-11-05).** Bun
itself is light enough that Docker support has no inherent value for
odbun, but the inherited Docker files (`deploy/Dockerfile*`, compose
files, docker workflows/docs) are *left untouched* unless a specific
workstream actually trips over them. If one does, that stream reports
the friction and the removal happens as its own small commit — no
big-bang Docker purge. If a Bun surface genuinely cannot carry a
feature yet, the item stays open and reported — it is never silently
routed back to Node.
