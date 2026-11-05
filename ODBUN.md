# odbun — OpenDesign, ported to Bun native

**odbun** is a standalone, Bun-native port of [OpenDesign](https://github.com/nexu-io/open-design).
It is not a patch layer over another project's build and it is not bound
to any other local CI: this repository is the port's own home, with its
own git history and its own GitHub Actions CI.

Status: **SCAFFOLD** (2026-11-05). The upstream base is imported
untouched; the Bun-native replacement layer exists and is tested in
isolation; the daemon does not yet boot under Bun. Porting work is
tracked in `PORTING.md` — nothing here claims more than is proven.

## Locked decisions (Hadi, 2026-11-05)

| Decision | Value |
|---|---|
| Base | Upstream release **open-design-v0.27.0** (commit `77b8eb8`), imported from a shallow reference checkout |
| Runtime | **Bun 1.4.4 only — Node is dropped entirely** (install, build, runtime, tests, CI) |
| Database | `bun:sqlite` via the port adapter (better-sqlite3 is removed, not shimmed at runtime) |
| Processes / PTY / HTTP / fetch | `Bun.spawn` / `Bun.Terminal` / `Bun.serve` / native fetch (see `port/BUN-TECH.md` for the full technology ledger) |
| Scope | **Web only** (daemon + `apps/web`) — desktop/packaged are out of scope by decision, not by omission |
| Repo | This repo, own history; will be published as a **public GitHub repo** with CI on **GitHub Actions** |
| Data dir (end-user install) | `data-od-bun/`, port **7457**, launcher shim named **`odbun`** |
| OpenCode support | v2 only, native at source level (no translator wrapper); MCP config + permission ruleset emitted in v2 form only |

## Layout of this repo

- Everything at the root and in `apps/`, `packages/`, `tools/`, … is the
  **upstream v0.27.0 base, byte-identical to the release** at import
  time. Port changes land as ordinary commits on top of this import, so
  the diff against upstream is always readable from git history.
- `port/` is the port's own layer:
  - `port/runtime/` — Bun-native adapters (db, spawn, pty, serve, fetch)
  - `port/tests/`, `port/spikes/` — `bun test` suite + standalone proofs
  - `port/BUN-TECH.md` — which Bun 1.4.x technologies are used, for
    what, which are rejected and why (re-judged for this port)
  - `port/DESIGN.md` — architecture, Node-surface census, replacement
    matrix, acceptance definition
  - `port/port-items.json` — the port work-item registry (P1–P5, R1–R5)
  - `port/odbun-shim` — the end-user launcher template (`odbun`)
- `.github/workflows/odbun-ci.yml` — this port's own CI (Bun only).
  Upstream's own workflows remain in the tree as part of the base
  import; odbun CI does not depend on them.

## CI (GitHub Actions)

`odbun-ci.yml` runs on push/PR with Bun 1.4.4
(`oven-sh/setup-bun`): it executes the port adapter test suite and all
four spikes. As porting stages land, the workflow grows the daemon
build + Bun smoke gates defined in `port/DESIGN.md` §4–§5. A red
workflow means the port layer is broken — by design there is no Node
fallback lane.

## Local verification (today's scaffold)

```bash
cd port
bun test            # adapter tests — 11 passing at scaffold time
bun run spikes/01-sqlite.ts
bun run spikes/02-spawn.ts
bun run spikes/03-serve.ts
bun run spikes/04-terminal.ts
```

## Attribution

Based on OpenDesign by the nexu-io community, Apache-2.0 (see
`LICENSE`). odbun is an independent port; upstream's data-directory
contract (`OD_DATA_DIR`, see base `AGENTS.md`) is honoured by the
end-user install (`data-od-bun/`).
