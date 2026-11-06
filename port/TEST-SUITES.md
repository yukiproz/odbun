# TEST-SUITES — upstream Vitest suites executed: dual-track record (2026-11-06)

Stream: `port/ci-tests` · Worktree: `odbun-wt-cit` · Base: `8f07e1c`
Machine: Yuki's VM · Bun **1.4.4** · Node v24.22.1 (preinstalled on
this VM; never installed by us — same posture as the CI runner)

**Question:** the upstream Vitest suites were typechecked on the
ported tree (R5-types) but never *executed*. Can they run in CI?

**Answer (dual track, Hadi's decision — "yang penting tes bisa
jalan"):** yes, on two tracks with different jobs:

1. **Gate — Node harness.** The suites were written for Node+Vitest;
   run them on the runner's *preinstalled* Node (no `setup-node`
   anywhere). This is the cleanest signal about the port itself.
2. **Experimental — Bun runtime.** The same daemon suite executed by
   Bun itself, `continue-on-error`, as the Bun/Vitest compatibility
   tracker. **Exit condition: when the Bun track is fully green, the
   Node track retires and Bun becomes the gate.**

**Exception, stated plainly:** Node appears ONLY as the disposable
test-harness runtime in track 1. Product runtime, install, build and
typecheck remain Bun-only everywhere, including in these jobs (the
install and closure build steps in both jobs are Bun).

Setup for every run below (verbatim CI recipe): filtered frozen
install — exit 0, 1,013 packages; closure build via postinstall +
pm-shim — exit 0, `apps/daemon/dist/cli.js` present.

**Execution venue (standing resource policy, Hadi 2026-11-06):**
this VM is resource-tight ("pas-pasan"), so full suites run in
**GitHub Actions** on runner resources; local VM runs are
subset/feasibility evidence only. Accordingly: the §3.1/§3.2 daemon
full runs below happened to complete locally minutes before this
policy landed — their totals stand as measured local evidence — but
they are not to be repeated locally, and the §3.3 web run was cut
short at its local bound under cross-suite contention; its
completion is offloaded to Actions. From here on, the Actions runs
of the two CI jobs are the canonical full-suite evidence.

---

## 1. The `bunx` shebang trap (read this first)

`bunx vitest` does **not** run Vitest under Bun when a `node` binary
is on PATH: the vitest bin carries `#!/usr/bin/env node`, and bunx
honours it — process inspection during the first full run showed the
Vitest CLI and its `forks.js` workers as `/usr/bin/node` processes.
This stream's first two "Bun" runs were therefore actually Node runs
(they are reported below as Node-track data — identical command,
identical results, twice). The true Bun form is:

```
bunx --bun vitest run -c vitest.config.ts
```

The CI Bun-track job uses `--bun`, with this note in a comment. Any
future "Vitest on Bun" claim without `--bun` (or an equivalent
runtime-forcing invocation) should be treated as unproven.

## 2. Port-touched subset (10 daemon files, both tracks)

Files: `mcp-config`, `byok-tools`, `asset-ssrf-loopback`,
`runtimes/agent-args`, `connection-test`, `db-agent-sessions`,
`db-message-events`, `db-workspace-resources`, `storage-db-inspect`,
`storage/touchpoint-replay-authority`.

### 2.1 Node harness — 243 passed / 1 failed of 244 executed; 3 files green

| File | Result |
|---|---|
| `tests/mcp-config.test.ts` | ✅ 92/92 — P3/P4 v2 shapes pass **at runtime** |
| `tests/byok-tools.test.ts` | ✅ 68/68 |
| `tests/asset-ssrf-loopback.test.ts` | ✅ 31/31 — R4 re-aimed assertions hold |
| `tests/runtimes/agent-args.test.ts` | ⚠️ 52/53 — pi fetchModels (§4.2) |
| 6 files (connection-test + 5 db/storage) | ❌ suite-level, 0 tests — `bun:sqlite` (§4.1) |

### 2.2 Bun runtime (`bunx --bun`) — 125 passed / **0 failed** of 125 executed; 3 files green

| File | Result |
|---|---|
| `tests/mcp-config.test.ts` | ✅ 92/92 |
| `tests/storage-db-inspect.test.ts` | ✅ 8/8 — dead on the Node track, alive here |
| `tests/storage/touchpoint-replay-authority.test.ts` | ✅ 25/25 — dead on the Node track, alive here |
| 7 files (incl. byok-tools, asset-ssrf, agent-args, connection-test, 3 db) | ❌ suite-level, 0 tests — `z.enum` interop (§4.3) |

**Every test that executed under the true Bun runtime passed.**

## 3. Full suites

### 3.1 Daemon, Node harness — completed in 937 s (inside the 1,200 s bound)

- **Files: 580 passed | 466 failed | 5 skipped (1,051)**
- **Tests: 8,442 passed | 149 failed | 72 skipped (8,663)**
- **435 of the 466 failed files are suite-level** (0 tests run) —
  the `bun:sqlite` wall (§4.1).
- The 149 failing tests sit in ~31 files, in families (samples in §4):
  server-boot suites (the daemon cannot run under a Node harness),
  spawn/detection suites routed through the port's Bun-only
  `execFileBun` (`ExecFileError: Bun is not defined`, version probes
  returning null), process-restart suites (child spawned with node
  dies on `ERR_UNSUPPORTED_ESM_URL_SCHEME … protocol 'bun:'`), the
  agent-process fixture daemon (crashes under Node), and **one
  genuine port leftover: `proxy-dispatcher-options` (§4.4)**.

### 3.2 Daemon, Bun runtime (`bunx --bun`) — bounded attempt

TRUE Bun, full daemon suite (`bunx --bun vitest run`, completed in
1,081 s, inside the 1,200 s bound):

```
Test Files  721 failed | 329 passed | 1 skipped (1051)
     Tests  95 failed | 3829 passed | 49 skipped (3973)
```

Reading: only 3,973 of the suite's ~8,663 tests even executed — the rest
never started because their files died at import. The failure mass is the
contracts/Zod interop class of §4.3: Vitest's summary groups files by
shared error, and the largest FAIL groups (including the entire `acp-*`
family) are headed by `TypeError: undefined is not an object (evaluating
'z.enum' | 'z.number' | 'z.object')`. `bun:sqlite` appears **zero** times
— the wall is inverted versus §3.1, exactly as the subset predicted. Of
the tests that did execute, 96% passed; the 95 executed-failures are a
small heterogeneous tail (JSON-parse assertions on very large stdout
payloads, one `vi.mock` hoisting error, one daemon-boot stdout timeout,
a few plain assertion diffs) — none sampled maps to a port-touched module.

### 3.3 Web, Node harness — bounded attempt

Web suite under the Node harness, local partial run: the suite holds
1,405 test files and is heavy (jsdom component tests, `--maxWorkers=2`);
running it concurrently with §3.2 on this VM, it was still mid-flight
when its 900 s local bound cut it, having completed **119 files: 114
passed, 5 with failing tests, ~4,308 tests executed**. The 5 files
(`EntryShell.amr-pending-handoff`, `FileViewer`,
`ProjectView.artifact-recovery-lifetime`,
`chat/record-progress-ink-latest-spec`, `runtime/srcdoc-bridge-empty-targets`)
fail on long, timing-sensitive component tests (individual failures at
5.8–5.9 s) under heavy cross-suite CPU contention — consistent with load
flakes, **not verified** either way; the dedicated CI runner (job timeout
60 min, nothing else running) is the arbiter. No web file is port-touched,
so no (a) signal is expected here; the run's purpose was command-form and
bin-path verification, both of which succeeded.

## 4. Triage

### 4.1 The `bun:sqlite` wall — hits BOTH tracks, differently

```
Error: Cannot find package 'bun:sqlite' imported from
  …/apps/daemon/src/bun/db.ts
   import { Database as BunDatabase } from "bun:sqlite";
```

- **Node track:** genuine absence — `bun:sqlite` exists only inside
  Bun. Every suite importing `src/db.ts` dies at collection (435
  files). Suites that spawn the built daemon with node die one level
  later (`ERR_UNSUPPORTED_ESM_URL_SCHEME … Received protocol 'bun:'`).
- **Bun track, Vitest resolution:** where a suite's graph reaches the
  adapter through Vite's node-style resolution/externalization, the
  same "cannot find package" occurs; suites importing the adapter
  through paths Bun resolves natively (e.g.
  `storage/touchpoint-replay-authority`, `storage-db-inspect`) run
  and pass. Either way this is **class (b) tooling/runtime interop**,
  not a port regression: the adapter passes under plain Bun
  (`port/` bun-test suite, daemon boot local + CI) and under the Bun
  track wherever it executes.
- Consequence for the gate: the Node-track job is red on DB suites
  from day one, by architecture — the port deliberately made the DB
  layer Bun-only. DB suites can execute today only where Bun is the
  runtime. Remedies NOT attempted here (out of scope): externalizing
  `bun:*` in `vitest.config.ts`, or migrating DB suites to `bun test`.

### 4.2 pi fetchModels — Bun-only code path under a Node harness

`agent-args > pi fetchModels reads the model table from stdout`
fails on the Node track: `pi.fetchModels` → `execAgentFile` →
`execFileBun` (the port's R2/R3 migration) → `Bun is not defined`
under Node → caught → `null`. Verbatim sibling evidence:
`tests/runtimes/exec-agent-cwd.test.ts` fails with
`ExecFileError: Bun is not defined`.

**Not a port regression:** a plain-Bun probe importing the real
`piAgentDef` with an equivalent fake binary returned exactly the
expected model list through the same `execFileBun` path — the code
is correct in its (only) target runtime. Class (b)/architecture:
any suite exercising Bun-API code paths in-process cannot run under
a Node harness; that is the port working as designed. (On the Bun
track this file is currently blocked earlier, by §4.3.)

### 4.3 `z.enum` — the Bun track's collection wall

All 7 suite failures in the Bun subset share one error:

```
TypeError: undefined is not an object (evaluating 'z.enum')
```

(JSC error dialect = genuinely Bun executing.) A shared module in
the failing files' import graph — the contracts/Zod layer — loads
with its `z` namespace undefined under Vitest-on-Bun's module
interop (CJS/ESM or circular-eval ordering), while files with
narrower graphs (mcp-config, the two storage suites) load fine.
Class (b) Bun/Vitest interop. No port code is implicated: the same
modules execute correctly in the built daemon under Bun.

### 4.4 (a) PORT REGRESSION — test-side leftover: `proxy-dispatcher-options`

`tests/proxy-dispatcher-options.test.ts` — **10 failing tests**, the
one genuine (a) found. They assert the pre-R4 undici contract:
`proxyDispatcherRequestInit()` returning a requestInit whose
`dispatcher` is an `EnvHttpProxyAgent`/`Socks5ProxyAgent`
("expected undefined to be truthy" — R4's requestInit now carries a
`proxy` string and no `dispatcher`, by design and as documented in
the R4 deviation record). The OC-cleanup stream re-aimed the sibling
files (connection-test, byok-tools, asset-ssrf) but this file was
missed. **Production behaviour is the intended R4 behaviour; the
debt is test-side**: re-aim these assertions at the `proxy`-string
contract like the siblings. Not fixed in this stream (report-only,
per scope).

### 4.5 (c) ENVIRONMENT

No failure required a missing network service, fixture download or
absent binary beyond the two harnesses' own semantics above. The
long tail of server-boot failures under the Node track is §4.1/§4.2
architecture, not environment.

## 5. CI design (`.github/workflows/odbun-ci.yml`, existing 3 jobs untouched)

- **`test-suites` (GATE, no continue-on-error, timeout 60m):**
  checkout → setup-bun → `node --version` assert (preinstalled; the
  workflow never installs Node) → pm-shim → Bun filtered frozen
  install → Bun closure build → daemon suite via
  `./node_modules/.bin/vitest` (bin exists per-package in the
  installed tree; its `env node` shebang selects the preinstalled
  Node) → web suite via `./node_modules/.bin/vitest …
  --maxWorkers=2` (its package.json form).
- **`test-suites-bun` (EXPERIMENTAL, continue-on-error, timeout
  45m):** same Bun install/build, then
  `bunx --bun vitest run -c vitest.config.ts` for the daemon suite
  (§1 explains why `--bun` is load-bearing).
- Both jobs carry the dual-track comment: the exception (Node =
  harness only), the rationale, and the exit condition.

## 6. Compatibility picture

- Under the **Node harness**, 8,442 daemon tests pass; the failures
  concentrate exactly where the port is *intentionally* Bun-only
  (DB layer, Bun spawn layer, the built daemon itself) — plus one
  stale test file (§4.4). For everything else, the Node track is a
  faithful upstream-grade signal.
- Under the **Bun runtime**, execution is perfectly green where it
  happens (subset 125/125; two DB-adjacent suites pass that cannot
  run under Node at all), but collection is capped by two interop
  walls: Vitest's `bun:` resolution on some paths and the `z.enum`
  module-interop failure on the contracts graph.
- Net: the suites *can* run in Actions today — as a dual track.
  Neither track alone tells the whole story yet; together they
  separate "the port is wrong" (almost nothing) from "the harness
  can't see Bun yet" (almost everything red).

---

## 7. Test adjustments to the port architecture (stream `port/test-adjust`, 2026-11-06)

Base: `a551445`. Hadi's decision: *"tes nya disesuaikan saja"* — adjust
the tests to the port's locked architecture. Production behaviour is
the source of truth wherever a port decision is locked (R4, the
Bun-only DB layer, the Bun spawn helpers); no production code was
edited in this stream, and no assertion was weakened to hide a
product failure. Local verification is focused-only per house rules;
the full-suite numbers belong to the next Actions run.

### 7.1 §4.4 closed — `tests/proxy-dispatcher-options.test.ts` re-aimed at R4

All 10 dispatcher-era tests converted; the undici mock and the
agent-constructor/dispatch spies are gone. Conversion map (old →
new assertion on `proxyDispatcherRequestInit()`):

- EnvHttpProxyAgent construction + forwarded timeouts → the init is
  exactly `{ proxy: 'http://proxy.example.test:8080' }`, no
  `dispatcher` key, timeout options accepted for call-shape
  compatibility, `close()` resolves.
- Socks5ProxyAgent on SOCKS `ALL_PROXY` → `{ proxy: 'socks5://…' }`
  (native fetch speaks socks5:// directly).
- `socks5h://` normalization → still normalized, now in the resolver:
  `{ proxy: 'socks5://…' }`.
- Timeouts into Socks5ProxyAgent → same call-shape test as the HTTP
  case.
- Per-scheme pair (×2: HTTP_PROXY-only, HTTPS_PROXY-only) → the
  configured HTTP(S) proxy wins over the SOCKS `ALL_PROXY` fallback
  in the single-string resolution.
- NO_PROXY bypass ×3 (loopback defaults, explicit `.corp.test`,
  `<local>` simple hosts) and the outside-NO_PROXY keep ×1 → expressed
  through the helper's `targetUrl` parameter: a bypassed target drops
  the proxy (`requestInit` is `{}`), a non-bypassed target keeps it.

**Dropped, with the reason recorded in the file header:** the
per-request `dispatch()` routing assertions (which agent receives a
given origin, incl. the "missing scheme routes to SOCKS" half of the
pair cases). A single `proxy` string has no per-request routing;
there is no counterpart to assert. One test was **added** beyond the
original 10: unset proxy env ⇒ `requestInit` is `{}` with no `proxy`
field (a semantic the brief for this stream lists explicitly).

Result: **11/11 green under BOTH harnesses** (Node bin and
`bunx --bun vitest`; the Bun side needed §7.4's fix to load at all).

### 7.2 §4.2 guards — Bun-only in-process paths skip under Node

New shared helper `apps/daemon/tests/helpers/runtime.ts` exports
`isBun` (`typeof Bun !== 'undefined'`). Guards applied at the
narrowest scope, each with a citing comment; guarded tests report
**skipped** (not failed, not passed) under Node and execute under
Bun:

| File | Scope | Tests |
|---|---|---|
| `tests/runtimes/agent-args.test.ts` | the single pi `fetchModels` test (`test.skipIf`) | 1 |
| `tests/runtimes/exec-agent-cwd.test.ts` | both describes (`describe.skipIf`) — every test calls `execAgentFile` in-process (verified by reading) | 3 |
| `tests/runtimes/codex-model-preflight.test.ts` | the 5 tests needing a successful version/login probe through the real `execFileBun` | 5 |
| `tests/runtimes/od-next-profile-permissions.test.ts` | the 1 test whose unmocked git probe must succeed via `execFileBun` | 1 |

Sibling sweep (the brief's bounded search — the other files that
reference `execFileBun`/`execAgentFile`, run focused under Node):
`tests/codex-model-capability-preflight.test.ts`,
`tests/od-next-automatic-simple-server.test.ts` and
`tests/runtimes/opencode-child-evidence.test.ts` die at collection —
they are §4.1 manifest files (§7.3), not guard cases;
`tests/runtimes/auth-probe-4456.test.ts` (11 ✓) and
`tests/runtimes/probe-ghost-cli.test.ts` (12 ✓) pass unguarded
(their spawn layer is fully mocked). `codex-model-preflight`'s
failure surface under Node is the swallowed-probe variant of §3.1's
spawn/detection family (probes return null → preflight degrades to
`unknown`), which is why its assertions diff instead of throwing
`Bun is not defined`.

Verified: under Node the two newly-guarded files went from
5-failed/1-failed to fully passed with the guarded tests skipped;
under Bun (with §7.4) all four guarded files execute — 26 passed /
1 skipped (the skip is the pre-existing root-uid guard in
od-next-profile-permissions) — including the pi `fetchModels` test
running green in `agent-args`.

### 7.3 §4.1 wall → committed exclusion manifest (Node harness only)

`apps/daemon/tests/node-harness-exclusions.json`: **435 entries**,
generated from the Actions Node-gate job log of run **42084483030**
(job `127445804657`) — per Hadi's resource policy the extraction ran
on the runner's log, not on a local full run. Method: parse the
Vitest *Failed Suites* section, attribute each grouped error to its
suite headers (both the bracketed form and the `FAIL file > describe`
form), keep the files whose collection error is the `bun:sqlite`
wall (the `'bun:'` scheme class matched zero additional files).
All 435 classified `bun:sqlite`.

**Delta check: zero.** The manifest's 435 equals both the CI run's
own "Failed Suites 435" headline and §3.1's local 435. Two parsing
subtleties worth recording: 8 of the 435 suites are reported in
`FAIL file > describe` form (their import graph dies inside a
describe hook — server-boot suites such as `server-startup-smoke`),
and 2 files appear in a second error group whose printed error is a
secondary teardown `TypeError` (reading 'close'/'shutdown'); both
were already classified by their primary group. The only
run-to-run movement vs §3.1 is in the test-level tail (CI files:
463 failed / 582 passed / 6 skipped vs local 466 / 580 / 5) — the
collection wall itself is identical. Regeneration recipe: re-run
the extraction against a newer Node-gate job log whenever the
suite inventory changes materially; the extractor used here is a
throwaway log parser, the manifest is the committed artifact.

Wiring (`apps/daemon/vitest.config.ts`): when the config executes in
a runtime without the `Bun` global, `test.exclude` is extended with
the manifest (each entry as a `**/<path>` glob); under Bun the
exclusion list is empty. Vitest's own default excludes are spelled
out explicitly because setting `exclude` replaces them. Verified by
collection listing both ways: `tests/storage-db-inspect.test.ts`
(a manifest entry) collects zero files under Node and lists its
tests under Bun; a non-manifest file lists normally under Node.

### 7.4 §4.3 Zod wall — one config attempt, kept

Budget was 3 attempts; the first worked, so B/C were never spent.

**Attempt A (KEPT): `ssr.noExternal: [/@open-design\/contracts/, /zod/]`**
in `apps/daemon/vitest.config.ts`. What it does: Vitest 4 has no
`server.deps.inline`; `ssr.noExternal` is its successor knob — it
forces Vite's module runner to transform and evaluate those two
packages instead of externalizing them, so Vite synthesizes zod's
CJS named exports itself rather than relying on the Bun external
module interop that produced the undefined `z` namespace.

Subset result under `bunx --bun vitest` (the 7 §2.2 dead files):
**0/7 → 6/7 files fully green** (`byok-tools`, `asset-ssrf-loopback`,
`agent-args` incl. the now-running pi test, `db-agent-sessions`,
`db-message-events`, `db-workspace-resources`), and the 7th,
`connection-test`, loads and executes: across the 7 files,
**340 passed / 5 failed of 345**. The 5 failures are all in
`connection-test` and are not interop and not port regressions —
that file has no green baseline on the ported tree under either
harness (it is a §7.3 manifest file under Node): 3 are this VM's
ambient proxy env (`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` all point
at the sandbox egress proxy and leak into the default-env code
paths the tests exercise; the runner has no ambient proxy), and
2 are agent-mode outcome diffs of the §3.2 heterogeneous-tail kind.
Node-track regression check with the final config: the 8-file
focused set passes (260 passed / 11 skipped / 0 failed), confirming
`noExternal` is a semantic no-op under Node.

Implication for §3.2's full-run numbers: the `z.*` interop groups
headed the largest Bun-track FAIL clusters (incl. the whole `acp-*`
family), so the Bun track's executed-test count should rise
substantially in the next Actions run; that run is the arbiter.

### 7.5 Expected posture after this stream

- **Node gate:** daemon scope is now the non-DB suites (435 DB
  suites excluded by manifest instead of failing at collection) plus
  the web suite; the 10 known Bun-path tests report skipped.
  Remaining known red on this track is the §3.1 test-level tail not
  covered here (process-restart suites whose node-spawned children
  hit the `'bun:'` scheme, the agent-process fixture daemon family)
  plus the 5 contention-sensitive web files of §3.3 — the gate's red
  is now legible and scoped, not yet zero.
- **Bun track (experimental):** the contracts/Zod collection wall is
  down (§7.4); DB suites are collected (no exclusions) and the
  guarded tests execute. §4.1's Vitest-resolution variant of the
  `bun:` wall on some import paths is untouched by this stream and
  remains the track's known unknown, to be measured by the next
  full Actions run.
- **Exit conditions (unchanged):** when the Bun track is fully
  green, the Node track retires — and with it the manifest, the
  runtime detection in `vitest.config.ts`, and the `isBun` guards'
  reason to exist (they degrade to always-run). The `ssr.noExternal`
  inlining stays as long as Vitest-on-Bun needs it.

Verification summary (this stream, focused only): item files green
under both harnesses as itemized above; `bun check -p
apps/daemon/tsconfig.tests.json` = 0 errors; port layer `bun test`
11/11; manifest JSON valid, sorted, 435 unique entries; config
loads under both runtimes (collection listings in §7.3).

## 8. Vela parked (stream `port/park-vela`, 2026-11-06)

Base: `a9660fb`. Hadi's decision: **park the Vela integration** in
the odbun build. Vela is upstream's team/cloud layer — an external
CLI the daemon shells out to via `src/integrations/vela-command.ts`,
carrying the collab adapters (`src/collab/vela-cli-*`), the AMR
runtime binary, and the login / billing / team-projects / share
surfaces. odbun's scope is local/single-user web; team features are
not carried. Vela is rooted in **122 src files**, so this is a park,
not a removal: **no production code and no test file was edited** —
the suites are excluded at the config level on both harnesses and
the code stays dormant. Registered as port item **V1**
(`port/port-items.json`) with a note in `PORTING.md` ("Out of scope
(by decision)").

### 8.1 The parked set — 73 files, two criteria

Committed as `apps/daemon/tests/parked-features.json` (sorted,
unique; same `tests/…` entry format as the §7.3 manifest), generated
by a throwaway census script; the manifest is the artifact.

- **(a) Name census — 32 files:** every `tests/vela-*.test.ts`.
  (Hadi's earlier "33" census counted `tests/mcp-vela-login.test.ts`
  as well; its name misses the glob, so it enters via (b).)
- **(b) Subject census — 41 files:** suites whose subject is the
  Vela integration or the AMR-via-Vela path, decided file by file
  from imports/subject and cross-checked against the FAIL lists of
  Actions run **42088193631** (Bun job `127458903603`, Node job
  `127458903508`). Groups:
  - Vela integration modules under test (11):
    `tests/integrations/vela{,-command,-errors,-terminal-command,-wallet,.routes}.test.ts`
    (6), `tests/media/vela.test.ts`,
    `tests/media/vela-workspace-routes.test.ts`,
    `tests/runtimes/vela-child-evidence.test.ts`,
    `tests/mcp-vela-login.test.ts`, `tests/resource-cli.test.ts`
    (the `od resource` Vela compatibility entry point). Group
    counts: 11 + 12 + 3 + 15 = 41; the manifest itself is the
    authoritative list.
  - AMR (vela) runtime path (12): `tests/amr-acp-integration`,
    `amr-auth-analytics`, `amr-image-staging`, `amr-login-cli`,
    `amr-session-resume`, `public-share-amr-link`,
    `tests/runtimes/amr-model-cache`, `amr-terminal-report-delivery`,
    `amr-terminal-reports`, `open-design-amr-trace-env`,
    `project-amr-trace-env`, `project-amr-workspace-proof`.
  - Vela media stock search (3): `tests/media-stock-daemon`,
    `media-stock-search-cli`, `media-stock-search` (the "company
    service" is reached through `vela-command` /
    `src/media/vela-stock-search.js`).
  - Team/cloud features whose only backend is the Vela CLI/hub (15):
    `tests/collab-cloud`, `collab-sync-routes`,
    `tests/collab/authorized-team-project-pull`, `hub-events-subscriber`,
    `owned-content-files`, `team-mirror-materializer`,
    `team-mirror-promotion`, `workspace-billing-expiry`,
    `workspace-billing-runtime`,
    `workspace-projects-reconcile-membership`,
    `tests/workspace-billing-server-wiring`,
    `workspace-context-authority-server-wiring`,
    `opend-3855-explicit-sync`, `public-share-project-bootstrap`,
    `publish-team-private-project-backfill`.

### 8.2 Borderline calls (recorded per the brief)

Parked, with the deciding fact:

- `tests/collab/owned-content-files.test.ts` — instantiates the
  real `createVelaCliTeamProjectCatalog`; the remote source under
  test is the adapter itself, not a stub.
- `tests/collab-sync-routes.test.ts` — the vela adapters are mocked,
  but the subject is the team-sync route surface itself, whose only
  production backend is those adapters.
- `tests/collab/hub-events-subscriber.test.ts` — a parser, but of
  the Vela hub event stream, including `vela-billing` quota scopes.
- `tests/collab/workspace-projects-reconcile-membership.test.ts` —
  the reconciler's remote side is the vela-cli team catalog,
  imported directly.
- `tests/publish-team-private-project-backfill.test.ts`,
  `tests/public-share-project-bootstrap.test.ts` — team publishing /
  share bootstrap wired directly to the vela-cli resource adapter /
  `registerVelaTeamProjectResource`.
- `tests/workspace-billing-server-wiring.test.ts` and
  `tests/workspace-context-authority-server-wiring.test.ts` —
  server wiring for the vela billing runtime / workspace-context
  authority (`VELA_*` env, team transports); both were in the Node
  track's 23-file failing set.
- `tests/amr-image-staging.test.ts` — a local fs helper, but its
  only caller is the AMR upload flow in `server.ts`; it exists
  solely within the AMR path.
- `tests/runtimes/amr-model-cache.test.ts` and
  `tests/runtimes/amr-terminal-reports.test.ts` — their transports /
  loaders are injected stubs, but the modules under test exist
  solely for the AMR (vela) catalog / terminal-report delivery;
  parked together with their transport-facing siblings
  (`amr-terminal-report-delivery` imports `vela-command` directly).

Stayed unparked, with the deciding fact:

- `tests/collab-presence-transport-off.test.ts` — tests the
  transport-OFF process-local presence fallback: exactly the
  configuration odbun runs. Parking it would remove coverage of the
  shipped mode.
- `tests/amr-stderr-filter.test.ts` — the filter lives in the shared
  ACP session layer (`src/agent-protocol/acp/*`, all ACP runtimes;
  the suite covers OpenCode bootstrap stderr) and drives no vela
  machinery.
- `tests/diagnostic-amr-runtime-log.test.ts` — subject is the
  general diagnostics-export source selection over local logs; AMR
  is one source among several.
- `tests/routes/workspace-projects.test.ts` — local
  workspace-project route behaviour (send-recency round-trip); vela
  modules supply context plumbing only.
- The P5 local publication/comment family
  (`public-file-publication-restart`, `public-file-error-chain`,
  `public-comment-anchor`, `comment-*`, `publish-http-comment-backfill`,
  `published-file-comment-backfill`, …) — local stores/outboxes with
  the vela boundary mocked away; their subject is the fully-local
  behaviour P5 exists to protect.
- `tests/run-failure-account-suspended.test.ts`,
  `tests/runtimes/balance-vs-rate-limit-snapshot.test.ts`,
  `tests/runtimes/tool-vs-agent-auth-snapshot.test.ts` — local
  failure-classification / landing-table suites; `vela-errors` is a
  mocked/fixture input, the module under test is local.
- `tests/touchpoint-cache-process-restart.test.ts` — zero vela
  references; a local touchpoint cache-process persistence suite
  (its 19 Node-track failures are the fork/tsx class of §3.1's tail,
  not vela).

### 8.3 Mechanism

`apps/daemon/vitest.config.ts` now composes three exclusion layers:
the spelled-out Vitest defaults (always), the §7.3
`node-harness-exclusions.json` (only when the `Bun` global is
absent), and `parked-features.json` (**always**, both runtimes —
a parked feature is off everywhere, not harness-dependent). The
`ssr.noExternal` Zod fix is untouched. The config comment block
carries the decision, its date, and the exit condition.

### 8.4 Expected effect per track (against run 42088193631)

- **Bun track** (was 24 failed files / 178 failed tests of 14,250;
  1,051 files collected): parking removes **5 failed files / 64
  failed tests** — `integrations/vela.routes` (34) +
  `integrations/vela` (16) + `integrations/vela-wallet` (10) are
  exactly the reported 60-test vela cluster, plus
  `runtimes/amr-terminal-report-delivery` (3) +
  `runtimes/amr-terminal-reports` (1). Expected remainder: 19 failed
  files / 114 failed tests, dominated by
  `od-next-automatic-simple-server` (85) — untouched by this stream.
  Collected files drop 1,051 → 978.
- **Node gate** (was 23 failed files / 127 failed tests; 616 files
  collected): parking removes **3 failed files / 22 failed tests**
  (`amr-acp-integration` 6, `workspace-context-authority-server-wiring`
  13, `workspace-billing-server-wiring` 3). Of the 73 parked files,
  25 were already excluded on this track via the §7.3 manifest; 48
  are newly excluded (their passing coverage on this track goes
  dormant with the feature — intended). Collected files drop
  616 → 568.
- **Exit condition:** a future decision to carry team features
  unparks Vela by deleting the manifest entries (and the config
  comment block); no other change is needed, because the product
  code never left the tree.

Verification summary (this stream, focused only): collection
listings under both harnesses — parked files
(`tests/vela-billing.test.ts`, `tests/integrations/vela.test.ts`)
collect **zero** under Node AND under Bun (the integrations case is
the discriminating one: no Node manifest applies under Bun, yet the
park still excludes), the non-parked collab neighbour
`tests/collab/swr-cache.test.ts` lists 9 tests under both, and the
manifest-only `tests/storage-db-inspect.test.ts` still lists 0
under Node / 8 under Bun (§7.3 behaviour unchanged). Focused run of
three unparked neighbours (`collab/swr-cache`,
`collab/workspace-scope`, `collab/event-refresh-coordinator`):
**3 files / 17 tests passed under both harnesses**. `bun check -p
apps/daemon/tsconfig.tests.json` = 0 errors (1,856 files;
`vitest.config.ts` is not part of that program — the collection
listings above are the config-load proof for both runtimes). Port
layer `bun test` 11/11. Manifest JSON valid, sorted, 73 unique
entries; `port-items.json` valid with V1 appended. Post-merge
full-suite Actions totals are the coordinator's step.

## 9. Usage-recovery journal-tail race — RESOLVED (2026-11-06)

**History (as parked earlier on 2026-11-06):** the suite
`tests/observability/usage-recovery.test.ts` failed intermittently on
the Bun track. After an in-process server restart, the events journal
(`events.jsonl`) was missing its trailing 1–4 records at the moment
the test read it (the normal, duplicate, and late native-usage
semantics cases failed most often). The records were late, not lost —
a 1.5 s delay before the read cured it 5/5 — and the failure was
pre-existing, not a port regression: identical code flipped
5/5 → 3/5 → 2/5 locally (stream `port/parity-bun-tail`) and failed on
the pristine base in CI runs 42098809569 (4 tests) and 42116642811
(3 tests). Suspects cleared at the time: Bun `fs.WriteStream`
write-callback and `end(cb)` ordering, and the stdout/stderr pipe
primitive behind the `cli.ts` flush fix. It was parked unfixed and
unmasked because no mechanism was proven; the unpark conditions were
usage accounting becoming load-bearing, or new evidence pinning the
mechanism in `runs.ts`.

**Unpark (Hadi, 2026-11-06):** direct order to chase the root cause
until the suite is reliably green under Bun (stream
`port/fix-usage-recovery-race`). Test-side masking stayed prohibited.

**Mechanism (proven):** journal writes are fire-and-forget.
`emit()` in `src/runtimes/runs.ts` hands each record to a per-run
`fs.WriteStream` with `stream.write(...)` and moves on;
`commitFinish()` closes the stream via `end(cb)` and stores that
flush as `run.eventsLogFinalFlush` — but nothing on the finish,
status, or shutdown path ever awaited it (only the SSE journal-replay
path did). Instrumented probes pin the tail's location at the failing
read: at the moment the live SSE stream completed, the journal file
was already 3–9 records behind the in-memory stream — including the
terminal `end` record — while the run was already reported
`succeeded`; write-callback tracing showed those records still
sitting in the stream's userland buffer (`writableLength` > 0) with
callbacks draining in bursts tens of milliseconds after `end()` was
called. So the tail was **emitted but not yet written** when the
restart boundary was crossed. Under Node the same buffer drains
within the time consumers spend on subsequent requests, which hid
the race; under Bun the drain lags measurably (1–2 records still
missing at the post-shutdown read, worst case outlasted only by the
1.5 s delay). The old suspect — replay emit scheduling vs
`pendingTerminalFinish` gating — was not the mechanism: gated emits
never reach the journal *or* the live stream, and the missing
records were all present in the live stream.

**Fix (production only, `src/runtimes/runs.ts`):** `shutdownActive`
now ends with a journal durability barrier — after active runs are
terminated it awaits every run's `eventsLogFinalFlush` before
returning. Shutdown is the restart boundary and recovery replays
these journals verbatim, so the boundary is no longer crossed with a
journal flush outstanding. No test changed; no behaviour change
under Node, where the flush settles promptly.

**Verification (2026-11-06):**

- Baseline, Bun track, 10 runs of the focused suite: normal 4/10,
  duplicate 5/10, late 5/10, missing-last 9/10, foreign-turn 8/10;
  every failure missed exactly 1–2 tail records at the post-shutdown
  journal read.
- After the fix: **10/10 consecutive Bun runs green — 50/50 cases.**
- Node track: the suite itself sits in
  `tests/node-harness-exclusions.json` (it boots the Bun-only
  daemon), so it never ran on the Node gate, before or after. The
  Node-runnable suites covering the touched module
  (`runtimes/runs`, `runtimes/runs-durable-replay`,
  `cancel-owned-runs`) pass 100/100 under the Node harness.
- Collateral: `tests/runtimes/opencode-service` 63/63 on both
  tracks; `bun check` clean on both daemon tsconfig programs
  (787 + 1,860 files).

**Scope note:** the barrier closes the graceful shutdown/restart
boundary. A hard process kill inside the finish-to-drain window can
still lose buffered tail records — that is inherent to the
asynchronous journal design (the write callback remains the
durability boundary, as the replay path documents) and closing it
would require synchronous journal writes, which was not attempted.

## 10. Web `z.enum` wall — RESOLVED (2026-11-06)

**History:** the web suite under Bun failed at collection in every file
(1,405/1,405, 0 tests) with `TypeError: undefined is not an object
(evaluating 'z.enum')` — CI runs 42179152723 and 42180766959. The daemon
side had already been unblocked by §7.4 (`ssr.noExternal` in the daemon
config); the web config had no equivalent.

**Mechanism (proven, stream `port/fix-zod-bun`):** Vitest's
external-module interop rebinds a non-`.mjs` module with a `default`
export to that default when `"__esModule" in mod.default` holds. That
probe is false for a module namespace under Node but true under Bun,
so on the Bun track zod's namespace (109 keys) was replaced by its
default export — the v3/external namespace (107 keys) — which lacks
the explicit `z` export. Every web suite importing
`@open-design/contracts` then died at collection on `z.enum`. Not a
zod bug and not a port regression: zod 3.25.76 is correct; the
interop probe is what differs between runtimes.

**Fix (config only, `apps/web/vitest.config.ts`):**
`server.deps.inline: ['zod']` — zod is transformed by Vite as ESM
instead of externalized, so the `z` binding survives on both
runtimes. (Vitest 4's `server.deps.inline` is the successor knob to
`ssr.noExternal` used in §7.4; same effect, web-side.) Commit
`d3b1b1e`, merged as `a2167eb`. No test changed; no behaviour change
under Node.

**Verification — CI run 42187225324 (tree `a2167eb`), overall
conclusion success:**

- Daemon step (Bun): **975 files passed / 5 skipped (980);
  12,727 tests passed / 24 skipped (12,751)** — green.
- Web step (Bun): **1,403 files passed / 2 failed (1,405);
  15,622 tests passed / 2 failed / 1 expected fail / 11 skipped
  (15,636)** — from 1,405 files failing at collection to 2
  individual test failures.
- Node gate, port layer, daemon smoke, typecheck: all green.

**Remaining red on the Bun track (2 tests, both new, neither is
the zod wall):**

1. `tests/components/cms-repro-a-lifecycle.test.ts` (OPEND-3363/3374/
   3376/3377/3378, case 3377) — `TypeError: undefined is not an
   object (evaluating 'stdout._handle.fd')`, surfacing from
   TypeScript 7.0.2's SyncRpcChannel. Bun incompatibility in the
   TS 7 native channel, not a port regression on its face.
2. `tests/components/FileViewer.deck-preview-blank-on-return.test.tsx`
   — `TestingLibraryElementError: Unable to find an element by:
   [data-testid="artifact-preview-frame"]`. Deck-preview
   iframe/render timing under Bun; note §3.3's Node-side FileViewer
   failures were load flakes — whether this one is a flake or a
   Bun-specific timing difference is **unverified**.

**Exit condition (unchanged):** the dual-track exit condition —
Bun fully green → Node track retires — is **not yet met**. The two
failures above are the only remaining blockers.
