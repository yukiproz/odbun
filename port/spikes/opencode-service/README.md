# Spike P6 — driving the opencode v2 user service

**Question:** can a client drive the opencode v2 **user service** — the
daemon registered by `opencode service start` — from a clean machine,
the way the official v2 client does, and can it run a real prompt on a
free model with no account configured?

The legacy `opencode serve` embed path is deliberately **not** used.
Everything here goes through the service: discovery from its
registration file, then plain HTTP against the service's own API.

## What it proves

- **Discovery works like the official client's**: read
  `<XDG_STATE_HOME>/opencode/service.json` (default
  `~/.local/state/opencode/service.json`), take `{url, pid, version,
  id}`, authenticate with the file's private password (HTTP Basic,
  user `opencode`), and probe `GET /api/info` — healthy means the body
  decodes to `{version, pid}` and the pid matches the registration.
- **The wire contract works end to end**: catalog (`/api/provider`,
  `/api/model`), session create bound to a directory, prompt admission,
  the SSE event stream (`/api/event`), session re-read (persistence),
  and session delete.
- **The free-tier auth question gets a measured answer** instead of a
  guess — see the run classification below.

What it does **not** prove: anything about a specific user's opencode
configuration, providers, or models. The runner starts from a vanilla
home directory; per-user acceptance happens separately.

## Files

- `spike-client.ts` — the staged probe (Bun + `fetch` only, no new
  dependencies). Writes `report.json` next to this README (override
  with `SPIKE_REPORT`) and prints a one-line verdict per stage.
- `opencode.json` — the custom-provider config installed by the
  workflow as the global opencode config (`~/.config/opencode/opencode.json`)
  in Baseten mode. See "Custom-provider mode" below.
- `../../../.github/workflows/odbun-opencode-spike.yml` — the
  dispatch-only workflow that installs the pinned binary, installs
  the custom-provider config, starts the service, runs the client,
  cleans up, and uploads the report.

## Custom-provider mode (Baseten)

The first spike run exercised a free model of the built-in
`opencode` provider; the free tier answered **429 (limit reached)**,
so the run stage never proved a real model execution. The spike now
runs instead through Hadi's own custom provider, copied verbatim
from his `opencode.jsonc`:

- **Config file:** `opencode.json` in this directory is
  `{ "providers": { "baseten-muse": { … } } }` — provider
  `baseten-muse` (name "Baseten"), package
  `aisdk:@ai-sdk/openai`, `baseURL https://inference.baseten.co/v1`,
  one model `meta-models/muse-spark-open-1026` ("Muse Spark Open
  (Baseten)") with variants `low` / `medium` / `high` / `xhigh`
  (each setting `reasoningEffort` to the same value) and limits
  context 1,048,576 / output 131,072.
- **Secret by name only:** the provider declares its credential as
  `"env": ["BASETEN_API_KEY"]` — the config file contains **no
  secret**. In Actions the value lives in the repo secret
  `BASETEN_API_KEY` and is passed as env to the *Start the opencode
  user service* step **only**, so the daemon process inherits it for
  provider resolution — mirroring Hadi's local export-then-restart
  usage. That step fails fast with an `::error::` if the secret is
  unset, and never echoes the value. No other step, the spike
  client, the report, or any artifact ever sees or records it.
- **Targeting:** the workflow runs the client with
  `SPIKE_PROVIDER=baseten-muse`,
  `SPIKE_MODEL=meta-models/muse-spark-open-1026`, and
  `SPIKE_VARIANT=low`. In this targeted mode the catalog stage polls
  up to 180 s for the exact target model (the aisdk package may need
  to be fetched on first load), records `targetModels` plus the
  target's variant ids, and session-create sends the model ref
  `{providerID, id, variant}`. The run stage is named `run-model`
  (free mode keeps `run-free-model`) and the report gains top-level
  `targetProvider` / `targetModel` / `targetVariant` fields.
- **Why variant `low`:** the spike only needs the cheapest, fastest
  wire proof that a real prompt executes through the service on this
  provider. Baseten's own default for this model is `xhigh`; `low`
  keeps the proof cheap without changing what is being proven (the
  service → provider → model path is identical).

Free mode is unchanged when the `SPIKE_*` envs are absent: the
client picks a free model of the built-in `opencode` provider as
before, with the 90 s catalog poll and the `run-free-model` stage.

## How to run

**GitHub Actions (the intended venue):** Actions → *odbun-opencode-spike*
→ Run workflow. Download the `opencode-service-spike` artifact for the
full `report.json` plus service logs.

**Local dry run:** start your own service first (`opencode service
start`), then from the repo root:

```bash
bun port/spikes/opencode-service/spike-client.ts
```

For targeted mode locally, set the same envs the workflow sets
(and have the provider's credential exported in the *service's*
environment before it starts — the client itself never needs it):

```bash
SPIKE_PROVIDER=baseten-muse \
SPIKE_MODEL=meta-models/muse-spark-open-1026 \
SPIKE_VARIANT=low \
  bun port/spikes/opencode-service/spike-client.ts
```

With **no service registered**, the client still writes a report: the
`discover` stage fails with the missing-file detail, every later stage
is recorded as skipped, and the exit code is 1. That is the correct
behaviour for a broken stage 1 — the reporting path works even when
there is nothing to talk to.

## Stages and exit semantics

| # | Stage | What it does |
|---|-------|--------------|
| 1 | `discover` | Parse the registration file (honours `XDG_STATE_HOME`). |
| 2 | `health` | `GET /api/info`; mirrors the official probe's ready/waiting/failed/incompatible classification, including the pid match. |
| 3 | `catalog` | `GET /api/provider` + `GET /api/model`, polled up to 90 s in free mode / 180 s in targeted mode (the snapshot may precede initial plugin settlement; a custom provider's aisdk package may need a first-load fetch). Records provider/model counts, the built-in `opencode` provider's free models (id/name contains `free`), and variant ids for a sample of models. Free mode picks the run model: a DeepSeek Flash free model if present, else the first free one. Targeted mode records `targetModels` (providerID === `SPIKE_PROVIDER` and modelID or id === `SPIKE_MODEL`) and picks the target. |
| 4 | `session-create` | `POST /api/session` with `location: {directory}` (a fresh temp dir) and the chosen model ref `{providerID, id}` — plus `variant: SPIKE_VARIANT` in targeted mode when set. |
| 5 | `run-free-model` / `run-model` | Opens `GET /api/event` (SSE), then `POST /api/session/:id/prompt` with `Reply with exactly: SPIKE_OK`. Settles on `session.execution.succeeded/failed/interrupted`, `session.status` → idle, or `session.idle` for the session; 120 s cap. Records event type names + counts and the final assistant text (from the messages endpoint). Named `run-free-model` in free mode, `run-model` in targeted mode. |
| 6 | `session-reread` | `GET /api/session/:id` + `GET /api/session/:id/message`; records message/content counts only. |
| 7 | `cleanup` | `DELETE /api/session/:id`. |

**Exit code:** 0 iff stages 1–4 and 6 pass — i.e. the wire contract
works. Stage 5's classification is *data*, never pass/fail; stage 7 is
reported but does not gate. A red workflow therefore means the service
machinery itself broke, not that a model run failed.

## Run classification

Exactly one of:

- **`RUN_OK`** — the run settled successfully and/or produced assistant
  text. (`spikeOkSeen` in the report records whether the text contains
  the exact `SPIKE_OK` marker.) The free tier is usable anonymously;
  P6 can rely on free models for wire-level tests.
- **`AUTH_REQUIRED`** — the prompt or the execution failed with an
  authentication-shaped error (HTTP 401/403, or an error mentioning
  auth/login/credentials). The wire contract still works, but real
  model runs need an opencode account credential — in CI that becomes
  an explicit secret decision, never a silent default.
- **`RUN_ERROR`** — anything else: no free model (free mode) or no
  target model (targeted mode) in the catalog, a transport failure,
  an execution error, or the 120 s timeout. The report carries the
  error shape and the event sequence for diagnosis.

## Endpoints used (grounded in the v2.2.5 reference tree)

| Call | Grounding |
|------|-----------|
| Registration file `<state>/opencode/service.json` → `{id?, version?, url, pid, password?}` | `packages/client/src/service.ts`, `service-probe.ts` (`fallback()`) |
| `GET /api/info` (health; Basic `opencode:<password>`) | `packages/client/src/service-probe.ts` (`probeResult`) |
| `GET /api/provider` → `{location, data: Provider.Info[]}` | `packages/protocol/src/groups/provider.ts` |
| `GET /api/model` → `{location, data: Model.Info[]}` | `packages/protocol/src/groups/model.ts` |
| `POST /api/session` `{title?, model?, location: {directory}}` → `{data: Session.Info}` | `packages/protocol/src/groups/session.ts`; `Location.PublicRef` in `packages/schema/src/location.ts` |
| `POST /api/session/:id/prompt` `{text}` | `packages/protocol/src/groups/session.ts`; `PromptInput.Prompt` in `packages/schema/src/prompt-input.ts` |
| `GET /api/event` (SSE; first event `server.connected`) | `packages/protocol/src/groups/event.ts` |
| Settle events `session.execution.*`, `session.status`, `session.idle` | `packages/schema/src/session-event.ts`, `session-status-event.ts` |
| `GET /api/session/:id`, `DELETE /api/session/:id` | `packages/protocol/src/groups/session.ts` |
| `GET /api/session/:id/message` → `{data: Session.Message[]}`; assistant text in `content[]` items tagged `text` | `packages/protocol/src/groups/message.ts`; `packages/schema/src/session-message.ts` |
| `Model.Ref {providerID, id}` matches `Model.Info.id` | `packages/schema/src/model.ts`; `packages/core/src/model-resolver.ts` |

The service password is only ever used to build the `Authorization`
header. It is never written to the report, the logs, or the uploaded
artifact (the workflow uploads a password-stripped copy of the
registration file).

## Pinned binary

From the `anomalyco/opencode` **v2.2.5** GitHub release:

- Asset: `opencode-linux-x64.tar.gz` (Linux x86-64, glibc — the
  `ubuntu-latest` runner shape), 119,196,162 bytes.
- URL: https://github.com/anomalyco/opencode/releases/download/v2.2.5/opencode-linux-x64.tar.gz
- SHA-256: `09f44302c10fd036912f59c81fd1aef5df45dd06f649197f9dfc9bbe2a79614e`
  — taken from the release asset digest served by the GitHub API and
  cross-checked against the `SHA256SUMS` file published in the same
  release (identical value).

## Results

Local verification (free checks only — no model run, no opencode
install on the dev VM), 2026-11-06:

- Workflow YAML parses; `workflow_dispatch` is the only trigger.
- `bun build port/spikes/opencode-service/spike-client.ts --target bun`
  succeeds.
- Client run with **no service registered**: `discover` fails
  gracefully (`ENOENT … service.json`), all later stages recorded as
  skipped, report written, exit 1 — as specified.
- Client run against a **shape-faithful local stub** of the service API
  (built from the same protocol sources, in /tmp, not committed): all
  seven stages pass; the run stage settles on
  `session.execution.succeeded`, records the event sequence
  `server.connected → session.status → session.execution.succeeded`,
  extracts the assistant text `SPIKE_OK`, classifies `RUN_OK`, exit 0.
  This validates the client's wire handling (data wrappers, pid match,
  SSE parsing, settle logic) — not the real service.
- First real-service result (free mode): the wire stages all passed
  on a clean runner, but the run stage classified `RUN_ERROR` —
  the free tier answered 429 "Free usage limit reached" before any
  assistant text was produced. That is what motivated the
  custom-provider (Baseten) mode above.
- First Baseten (custom-provider) result: **pending** — the workflow
  has not been dispatched in Baseten mode yet at the time of
  writing. The coordinator dispatches it and records the
  classification here.
