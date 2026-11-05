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
