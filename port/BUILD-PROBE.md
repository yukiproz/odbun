# BUILD-PROBE — Bun build system probe for odbun (2026-11-05)

Stream: `port/build-bun` · Worktree: `odbun-wt-build` · Base: `3975cf1`
Machine: Yuki's VM · Bun **1.4.4** (`/home/linuxbrew/.linuxbrew/bin/bun`)
Note on environment: this VM also has a Node binary (`/usr/bin/node`
v24.22.1). Several findings below hinge on that: where a build script
says `node`, a real Node **did** run. The probe never invoked node
directly; every such invocation came from upstream scripts.

Method note (step 2): the pm-shim used lives at `/tmp/odbun-probe/pm-shim`
(probe-scoped, not committed). It is the parent CI's shim with two
deliberate changes: package.json parsing via `bun -e` instead of
`node -e`, and **no node-gyp-bin PATH injection** (node-gyp is part of
the Node native toolchain this port deletes). It translates
`-C <dir> run <script>` → `cd <dir> && bun run <script>` and
`--filter <ws> rebuild <pkg>` → that package's own lifecycle scripts.

---

## 1. Filtered install — WORKS (slow on this VM)

Command (exactly as specified, web closure, 15 filters):

```
ONNXRUNTIME_NODE_INSTALL_CUDA=skip bun install --ignore-scripts \
  --filter open-design --filter @open-design/web --filter @open-design/release \
  --filter @open-design/contracts --filter @open-design/components \
  --filter @open-design/platform --filter @open-design/host \
  --filter @open-design/registry-protocol --filter @open-design/agui-adapter \
  --filter @open-design/plugin-runtime --filter @open-design/sidecar-proto \
  --filter @open-design/launcher-proto --filter @open-design/sidecar \
  --filter @open-design/diagnostics --filter @open-design/daemon
```

- **Attempt 1**: **exit 0, 407 s, `1037 packages installed`**, footer
  includes the pnpm→Bun manifest migration lines and `Saved lockfile`
  (plus `Blocked 4 postinstalls` — the `--ignore-scripts` holds, see
  `bun pm untrusted`). Lockfile migration from `pnpm-lock.yaml` took
  81.99 s of the run; resolution line: `Resolved, downloaded and
  extracted [2312]`. (Process note: attempt 1's completion was only
  delivered after this probe's later steps had started — a mid-run
  tree check at ~200 s showed the log ending at extraction with no
  `bun.lock` yet, which is why attempt 2 exists at all. The two runs
  overlapped; final tree consistency is proven independently by the
  §2 frozen-lockfile pass, the dedupe pass, and both green builds.)
- **Attempt 2** (identical command, started before attempt 1's
  completion was visible): **exit 0, 190 s**, `6 packages installed`
  (incremental over attempt 1), `bun.lock` present at 375,393 bytes,
  and Bun's pnpm→Bun manifest migration applied to root
  `package.json` (see §6).
- Totals for the closure: **1,369 packages** in the resolution set
  (matches the parent's count exactly), 1,043 entries in the
  `node_modules/.bun` store, **`node_modules` = 2,048 MB**.
- No install errors in either attempt.
- Differences vs the parent project's numbers (~900 pkgs / 1.6 GB /
  seconds): (a) this command does **not** apply the parent's Stage-2.6
  pruning of the root `tools-*` devDependency links, so the desktop
  packaging chain's tail is heavier here; (b) this VM's disk/cache is
  far slower than Hadi's machine — even the incremental attempt took
  190 s. Budget CI time accordingly; do not copy the parent's timings.
- `bun dedupe --check`: **PASS** — "No duplicates — checked 1369
  packages in bun.lock" (12 ms).
- `bun audit`: **unavailable here** — the registry bulk-advisories
  POST timed out from this VM. Informational only; the parent's
  measured summary (225 vuln / 6 critical) remains the reference.

## 2. Frozen lockfile — VERDICT: ADOPTABLE for this tree (BUN-TECH §4 re-evaluation answered)

- `bun install --ignore-scripts --frozen-lockfile` (same 15 filters):
  **exit 0, 246 ms** — `Checked 1074 installs across 1369 packages
  (no changes)`.
- Re-checked **after** the `packageManager` edit in §6 (subset
  filters): exit 0, no changes. The field is not part of lockfile
  validation.
- Why it works here but failed in the parent: the parent's rsync
  pattern restored a *pristine* root manifest against a kept
  `bun.lock` (manifest⇄lock mismatch by construction). This standalone
  tree keeps Bun's migrated manifest **and** its lockfile together.
- **Adoption rule**: commit the migrated root `package.json` and
  `bun.lock` as one unit (done in this stream's commit); never restore
  the pristine manifest while keeping `bun.lock`.

## 3. Workspace build (postinstall `build` phase via pm-shim) — GREEN, but NOT node-free

Command:

```
OPEN_DESIGN_POSTINSTALL_CONCURRENCY=2 \
OPEN_DESIGN_POSTINSTALL_TARGETS='["apps/daemon","packages/host","packages/components"]' \
npm_execpath=/tmp/odbun-probe/pm-shim \
bun scripts/postinstall.mjs build
```

(`scripts/postinstall.mjs` itself ran under Bun with no changes — its
`node:*` imports are Bun-implemented APIs.)

- **Exit 0, 27 s.** Selected closure = the parent's 13 targets, built
  in upstream's topological order. Every target's `dist/` verified to
  exist afterwards (exit code alone is not proof — the `bun --cwd`
  lesson): release 4 files, contracts 357, components 18, platform 15,
  host 16, registry-protocol 7, agui-adapter 7, plugin-runtime 25,
  sidecar-proto 3, launcher-proto 3, sidecar 38, diagnostics 9,
  **apps/daemon 2,346 files** (incl. `dist/cli.js`).
- **Node-invocation findings (the real result of this step):**
  - 10 of the 13 closure packages build with a literal
    `node ./esbuild.config.mjs && tsc …`: agui-adapter, contracts,
    diagnostics, host, launcher-proto, platform, plugin-runtime,
    registry-protocol, sidecar-proto, sidecar. A real Node binary ran
    for each (Node exists on this VM).
  - 2 closure packages build via `tsx ./esbuild.config.ts …`:
    components, release. (tsx is a Node-ecosystem runner; whether its
    bin executed under Bun or Node in this run is not distinguished —
    recorded as Node-ecosystem either way.)
  - Same pattern outside the closure (not built here): download,
    metatool (`node`), dsh-runtime, standalone (`tsx`).
  - Root `package.json` scripts also invoke node directly:
    `postinstall`/`bootstrap` = `node ./scripts/postinstall.mjs`,
    plus `sync:community-pets`, `bake:community-pets`,
    `seed:test-projects`, `seed:curated-design-skills`,
    `backfill:failed-runs` (`node --experimental-strip-types …`).
    Daemon package scripts (`daemon`/`dev`/`start`) call
    `node dist/cli.js` and `pnpm …` — runtime-side, owned by the
    daemon streams, noted here for completeness.
- **Counter-evidence that the fix is small** (probe-run, not edited —
  `packages/*/package.json` is outside this stream's owned files):
  - `bun ./esbuild.config.mjs` in `packages/platform`: **runs OK**
    (the config is plain ESM driving the esbuild binary; its
    `platform: "node"` / `target: "node24"` are esbuild *target
    labels*, not a Node runtime requirement).
  - `bun ./esbuild.config.ts` in `packages/release`: **runs OK**
    (Bun executes TS configs natively; tsx is unnecessary).
  → Proposal P1 (§7): replace `node ./esbuild.config.mjs` → `bun
  ./esbuild.config.mjs` and `tsx ./esbuild.config.ts` → `bun
  ./esbuild.config.ts` in package build scripts.
- Deliberately **not** run: the postinstall `dependencies` phase
  (native rebuild of better-sqlite3 via `--filter … rebuild`). Its
  path is `prebuild-install || node-gyp rebuild` — the Node native
  toolchain this port deletes, and R1/R2 moot it entirely. Skipping
  it is a design consequence, not an omission.

## 4. Web build — GREEN, file count identical to the parent's proven build

- `(cd apps/web && bun run build)` (`next build && tsc -b --noEmit`):
  **exit 0, 138 s** (Next.js 16.2.6 Turbopack compile 90 s of it;
  static generation 4/4 pages; the trailing `tsc -b` passed as part
  of the same script exit 0).
- `apps/web/out/` verified: `index.html` present, **767 files** —
  exactly the parent's proven count.
- Next's internal workers ran under the `bun run` process tree; no
  explicit `node` invocation appears in the web build log.

## 5. Daemon boot smoke under Bun — FAILS at load; first wall is undici (R4), then the native addons (R1/R2)

Command: `OD_DATA_DIR=/tmp/odbun-smoke bun apps/daemon/dist/cli.js
--no-open --port 17457` (own process group via `setsid`).

- The daemon **exits immediately**; the entire log is:

  ```
  SyntaxError: Export named 'Socks5ProxyAgent' not found in module 'undici'.
  Bun v1.4.4 (Linux x64)
  ```

- Source site: `apps/daemon/dist/connectionTest.js:23` —
  `import { Agent, EnvHttpProxyAgent, Socks5ProxyAgent } from 'undici'`.
  Under Bun, `undici` resolves to Bun's **bundled** undici, which does
  not export `Socks5ProxyAgent`; the static named import fails at load
  time, before any route or DB code runs. (Under Node + the npm
  undici package this import resolves — it is also what the parent's
  Stage-3 relocatable patch worked around. In this port R4 deletes
  undici outright, which removes this wall by construction.)
- `/api/health` never answered: 15 curl tries over 15 s, all
  connection-refused. The process was already dead on its own; PGID
  verified dead and **port 17457 verified free** afterwards —
  clean close required no kill.
- The walls behind it, probed directly from `apps/daemon` under Bun:
  - `better-sqlite3`: `Could not locate the bindings file. Tried:
    …/node_modules/.bun/better-sqlite3@12.10.0/…/build/Release/
    better_sqlite3.node …` — no `.node` binary exists in this tree
    (`--ignore-scripts` + no native rebuild, §3). And even with a
    binary, Bun refuses the addon (oven-sh/bun#4290, parent-proven).
    Both layers are R1's justification.
  - `node-pty`: `Failed to load native module: pty.node … Cannot find
    module './prebuilds/linux-x64//pty.node'` — the package ships
    prebuilds only for darwin/win32; Linux was always a local
    node-gyp build. R2's justification.
- Conclusion: boot is blocked in the expected order — **R4 (undici)
  first, then R1/R2**. No boot retest is meaningful until those land.

## 6. Changes MADE in this stream (proven by the probe)

1. **Root `package.json`** — two parts, committed together:
   - Bun's own install-time migration, produced by the §1 command:
     `overrides`, `workspaces`, `trustedDependencies` copied from the
     pnpm metadata (this is the workspace migration PORTING.md calls
     for; §2's frozen verdict depends on keeping it).
   - `packageManager`: `"pnpm@10.33.2"` → **`"bun@1.4.4"`** — the
     probe ran every stage through Bun; the field now states the
     fact. Frozen-lockfile re-check after this edit: still PASS.
2. **`bun.lock`** (375,393 bytes) — new, committed as the lockfile of
   record, per the §2 adoption rule.
3. **`port/BUILD-PROBE.md`** — this file.

Nothing else was edited. `pnpm-workspace.yaml` and `pnpm-lock.yaml`
are intentionally left in place for now: other upstream tooling
(guard, workspace scripts) still references them, and removing them
is a separate, deliberate step once the Bun-native replacements for
those consumers exist.

## 7. Proposals (NOT done — outside owned files or unproven)

- **P1 — package build scripts**: `node ./esbuild.config.mjs` →
  `bun ./esbuild.config.mjs` (10 packages in closure; also download,
  metatool) and `tsx ./esbuild.config.ts` → `bun ./esbuild.config.ts`
  (components, release, standalone, dsh-runtime). Evidence §3:
  both forms probe-run OK. Owner: whichever stream takes
  `packages/*` build config; must re-run the §3 closure build after.
- **P2 — root scripts**: `postinstall`/`bootstrap` →
  `bun ./scripts/postinstall.mjs` (proven: §3 ran it under Bun);
  the `node --experimental-strip-types` seed/sync/bake scripts →
  `bun <script.ts>` (Bun strips types natively; each script still
  needs its own run-probe before flipping).
- **P3 — permanent pm-shim home**: promote `/tmp/odbun-probe/pm-shim`
  (Bun-flavoured variant) into the repo (candidate: `tools/pm-shim/`
  or `scripts/pm-shim`) when the build pipeline is productised, so
  the §3 command doesn't depend on /tmp.
- **P4 — root tools-\* pruning**: apply the parent's Stage-2.6 prune
  (remove root `tools-*` devDependency links before install) to cut
  the closure's node_modules from 2,048 MB toward the parent's
  1.6 GB. Unproven here — the §1 command deliberately ran unpruned.
- **P5 — CI stages**: odbun-ci can now honestly add: filtered install
  with `--frozen-lockfile`, the §3 closure build (after P1, or with
  the node-invocation caveat recorded), and the web build. Daemon
  smoke stays OUT of CI until R4+R1+R2 land (§5).

## 8. Unverified / open

- Daemon behaviour past the undici wall (needs R4, then R1/R2).
- Whether Next/Turbopack internals ever spawn a `node` binary under
  `bun run` in edge paths (build log shows none; not instrumented
  with process accounting).
- GitHub Actions timings for §1/§3/§4 (this VM is markedly slower
  than Hadi's machine; CI numbers will differ).
- `bun audit` from a network that can reach the advisories endpoint.
- Full upstream test suites (Vitest) — out of this probe's scope by
  design (see BUN-TECH §3).
