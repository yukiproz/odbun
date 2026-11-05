# SMOKE-MAIN — acceptance smoke on merged main (2026-11-05)

Stream: `port/smoke-main` · Worktree: `odbun-wt-smoke` · Base: `41ba6d5`
(merge of `port/build-bun` into main, on top of all port streams:
R1, R2, R3-partial, R4, P1–P4, P5, OC-follow).
Machine: Yuki's VM · Bun **1.4.4** (`/home/linuxbrew/.linuxbrew/bin/bun`)
Recipe source: `port/BUILD-PROBE.md` (install filter set §1, frozen
verdict §2, postinstall build §3, pm-shim at `/tmp/odbun-probe/pm-shim`
— still present on this VM, reused as-is, no recreation needed).

**Headline: the daemon BOOTS under Bun on merged main and answers
`/api/health` with 200.** The undici wall that killed the probe's
smoke (BUILD-PROBE §5) is gone — `dist/connectionTest.js` contains
zero `undici` references. Two real findings remain, both recorded
below: the daemon's `tsc` build step fails with 13 type errors (the
esbuild bundle is still emitted and is what booted), and the frozen
lockfile needed one regeneration (committed in this stream).

---

## 1. Install — frozen FAILED on manifest drift; plain install regenerated the lockfile

Frozen attempt (exact probe filter set, 15 filters, `--ignore-scripts
--frozen-lockfile`, `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`):

```
bun install v1.4.4 (5d9cc0f4f)
error: lockfile had changes, but lockfile is frozen
note: dependencies in package.json changed since bun.lock was saved:
      @types/better-sqlite3 was removed in apps/daemon
note: try re-running without --frozen-lockfile and commit the updated lockfile
```

Exit 1, <1 s. Exactly the predicted drift: since the probe's lockfile
was generated, merged main removed `better-sqlite3` + `@types/better-sqlite3`
(R1) and `node-pty` (R2) from `apps/daemon/package.json`.

Plain filtered install (same command minus `--frozen-lockfile`):

- **Exit 0, 5 s** (warm Bun store on this VM — the probe's installs
  already populated it; do not read this as a cold-cache number),
  **1,011 packages installed**, `Removed: 3`, `Blocked 2 postinstalls`.
- `bun.lock` diff vs the committed probe lockfile: **1 insertion,
  73 deletions** — the `better-sqlite3` / `@types/better-sqlite3` /
  `node-pty` resolution entries are gone. Post-regeneration,
  `grep -c "better-sqlite3" bun.lock` = 0 and `grep -c "node-pty"
  bun.lock` = 0.
- Frozen re-check after regeneration (subset filters daemon+web):
  **exit 0** — `Checked 864 installs across 1345 packages (no
  changes)`. The regenerated `bun.lock` is committed in this stream,
  so `--frozen-lockfile` is adoptable again from this commit on.
- `node_modules` = 2.0 GB (unpruned closure, same as the probe).

## 2. Workspace build — 12/13 targets green; daemon fails at `tsc` (13 type errors), bundle still emitted

Command (probe §3, verbatim):

```
OPEN_DESIGN_POSTINSTALL_CONCURRENCY=2 \
OPEN_DESIGN_POSTINSTALL_TARGETS='["apps/daemon","packages/host","packages/components"]' \
npm_execpath=/tmp/odbun-probe/pm-shim \
bun scripts/postinstall.mjs build
```

- **Exit 1, 32 s.** Selected closure = the same 13 targets in
  upstream topological order. **12 built green**: release, contracts,
  components, platform, host, registry-protocol, agui-adapter,
  plugin-runtime, sidecar-proto, launcher-proto, sidecar,
  diagnostics. **`apps/daemon` failed with exit code 2** — its build
  script's `tsc -p tsconfig.json` step.
- The daemon's esbuild bundle was nevertheless emitted before the
  typecheck ran: `apps/daemon/dist/` = **2,355 files** incl.
  `dist/cli.js` (probe's pre-merge tree: 2,346). Type errors do not
  block esbuild emit; §3 below booted this exact dist.

### The 13 type errors (complete list — this is follow-up work for a types stream)

Root cause A — the daemon tsconfig has no Bun type definitions in
scope (no `bun-types` / `@types/bun` resolvable), so every Bun-native
surface the port introduced is invisible to `tsc` (10 errors):

```
src/bun/db.ts(31,41):    error TS2307: Cannot find module 'bun:sqlite' or its corresponding type declarations.
src/bun/pty.ts(53,18):   error TS2868: Cannot find name 'Bun'.
src/bun/pty.ts(74,27):   error TS2868: Cannot find name 'Bun'.
src/bun/pty.ts(95,19):   error TS2868: Cannot find name 'Bun'.
src/bun/spawn.ts(56,16): error TS2868: Cannot find name 'Bun'.
src/bun/spawn.ts(78,10): error TS2868: Cannot find name 'Bun'.
src/bun/spawn.ts(99,17): error TS2868: Cannot find name 'Bun'.
src/bun/spawn.ts(132,19): error TS2868: Cannot find name 'Bun'.
src/bun/spawn.ts(222,15): error TS2868: Cannot find name 'Bun'.
```

Root cause B — `exactOptionalPropertyTypes: true` mismatches where
port code passes explicit `undefined` into optional fields (3 errors):

```
src/bun/spawn.ts(134,19): error TS2379: '{ cwd: string | undefined; env: … | undefined }'
  not assignable to 'SpawnOptions' — property 'cwd': 'string | undefined' vs 'string'.
src/mcp-config.ts(527,50): error TS2379: property 'readOnlyEditBaseDirs':
  'string[] | undefined' not assignable to 'string[]'.
src/runtimes/invocation.ts(42,59): error TS2379: property 'env':
  'NodeJS.ProcessEnv | undefined' not assignable to 'Record<string, string | undefined>'.
```

Root cause C — one pre-existing-looking signature mismatch surfaced
in R4-touched code (1 error):

```
src/connectionTest.ts(1486,67): error TS2345: Argument of type 'ParsedBaseUrl'
  is not assignable to parameter of type 'string | URL | undefined'
  (missing URL properties: hash, host, href, origin, …).
```

Suggested shape of the fix (NOT done here — source edits are outside
this stream): add Bun types to the daemon's type resolution
(`bun-types` as a devDependency + `"types"` entry, or a
`src/bun/bun.d.ts` reference), and align the three
`exactOptionalPropertyTypes` call sites / option types. Until then
the closure build's daemon target reports red even though its
runtime bundle is complete and bootable.

## 3. Daemon boot smoke — ✅ PASS (health 200, projects 200, DB live through the bun:sqlite adapter)

Command:

```
OD_DATA_DIR=/tmp/odbun-smoke-main bun apps/daemon/dist/cli.js --no-open --port 17457
```

(launched via `setsid`, own session; daemon bun PID was **60346**).

- **`/api/health` → HTTP 200** on the first poll (~2 s after launch):

  ```json
  {"ok":true,"version":"0.25.1","amrTerminalReporter":{"status":"active","pending":0,"delivered":0,"unsupported":0,"terminalFailed":0,"oldestPendingAgeMs":null}}
  ```

- Daemon log tail: `[plugins] registered 478 bundled plugin(s)`,
  registry sources seeded, telemetry sink `none`, then
  `[od] listening on http://127.0.0.1:17457`. **No error/warn lines**
  anywhere in the boot log.
- **`GET /api/projects` → HTTP 200**, body `{"projects":[]}` — a real
  route answered through the full stack (not just the health stub).
- **DB evidence (R1 adapter live):** `OD_DATA_DIR` contains
  `app.sqlite` (4,222,976 B) + `app.sqlite-wal` / `-shm` created by
  the daemon at boot. A separate read-only `bun:sqlite` script
  against that file found **62 tables** (full migration set —
  `projects`, `conversations`, `messages`, `workspace_projects`,
  `public_file_publications`, …) and `projects` row count **0**,
  matching the `{"projects":[]}` response. The DB was created and
  migrated by the daemon running on the `src/bun/db.ts` adapter;
  no `better-sqlite3` package exists in this tree's lockfile or
  `node_modules` resolution (see §1).

### Node-in-runtime check

- The daemon's process tree at steady state was the single `bun`
  process (PID 60346) and its threads — **no child processes**, and
  `pgrep -x node` found **no node process anywhere on the machine**
  while the daemon ran. Nothing in the boot path invoked a `node`
  binary. (Build-time `node ./esbuild.config.mjs` invocations from
  package build scripts remain as documented in BUILD-PROBE §3 /
  proposal P1 — build-time only, unchanged, not re-litigated here.)

### Clean close

- Daemon killed **by PID** (`kill 60346`); verified: process dead,
  **port 17457 free**, `/api/health` no longer answers, no stray
  `dist/cli.js` processes. Smoke data dir left at
  `/tmp/odbun-smoke-main` (ephemeral) as evidence.

## 4. Verdict summary

| Stage | Verdict |
|---|---|
| Install (frozen) | ❌ failed on manifest drift → regenerated (§1) |
| Install (plain, regen) | ✅ exit 0, 1,011 pkgs; frozen passes again afterwards |
| Workspace build | ⚠️ 12/13 green; daemon `tsc` red (13 type errors, §2), bundle emitted |
| Daemon boot under Bun | ✅ **health 200, /api/projects 200, 62-table DB via bun:sqlite adapter** |
| Node in runtime boot path | ✅ none observed |
| Clean close | ✅ PID killed, port free, no strays |

## 5. Unverified / open

- Anything past boot: no agent run, no chat, no PTY session, no MCP
  config emission was exercised — routes answered and the DB
  migrated; deeper acceptance belongs to later streams.
- The daemon `tsc` failure (§2) means `bun scripts/postinstall.mjs
  build` exits 1 overall until a types stream fixes it; CI should
  not yet treat the closure build as a green gate for the daemon
  target.
- Web build was not re-run in this stream (proven green on the
  pre-merge tree in BUILD-PROBE §4; the web closure's packages all
  rebuilt green here, but `apps/web` itself was not rebuilt).
- Same VM-speed and `bun audit` caveats as BUILD-PROBE §8.

## 6. Changes made in this stream

1. **`bun.lock`** — regenerated by the plain filtered install (§1);
   removes the R1/R2-deleted packages from the resolution set
   (73 deletions, 1 insertion vs the probe lockfile).
2. **`port/SMOKE-MAIN.md`** — this file.

Nothing else. No source file, no `package.json`, no other doc edited.
