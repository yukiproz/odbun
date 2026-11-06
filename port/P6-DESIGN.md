# P6 — OpenCode deep integration: odbun as a first-class client of the user's opencode service

**Status:** designed (2026-11-06). Not yet implemented.
**Scope:** `apps/daemon` (runtime layer), `apps/web` (status + picker surfaces), `packages/contracts` (one agent-info extension), the `od` CLI.
**Evidence base:** `port/spikes/opencode-service/README.md` (two real-service spike runs, cited as *spike run 1* and *spike run 2* below).
**Grounding:** every claim about the opencode v2 API is cited to the pinned v2.2.5 reference tree (`~/workspace/references/opencode-v2`, commit `9bbb8ce`); every claim about the odbun daemon is cited to `apps/daemon/src`. Anything not verified that way is listed in §12, never stated as fact.

---

## 1. Summary & scope

Today odbun drives OpenCode the way it drives every other coding-agent CLI: the daemon spawns `opencode run --format json` per turn, feeds the prompt on stdin, and parses the child's stdout event stream (`apps/daemon/src/runtimes/defs/opencode.ts`). P1–P4 made that def speak the v2 dialect; P6 changes the *transport*, not the dialect.

**P6 makes the daemon a first-class client of the user's own opencode service** — the long-lived daemon the user starts with `opencode service start` and uses from the official app/TUI. The daemon discovers that service from its registration file, probes it the way the official client does, and then works entirely through the v2 HTTP API: sessions are created inside the service, prompts are admitted through its durable inbox, progress arrives over its server-wide event stream, and the model catalog is read from the service itself.

What changes for the user:

- An odbun conversation with the OpenCode agent *is* an opencode session in their service: it shows up in their opencode app, survives odbun restarts, and can be reattached rather than reconstructed.
- The model picker and the reasoning-variant (effort) control are fed by the service's live catalog, so the user's own providers — including custom providers such as `baseten-muse` — appear exactly as configured on their machine (proven by spike run 2, §2).
- Permission requests and agent questions become interactive round-trips (§6) instead of headless auto-rejections.
- No per-turn CLI process, no stdout parsing, no throwaway `opencode serve` instances for catalog discovery.

**Locked decisions** (Hadi, 2026-11-06 — encoded here, not relitigated):

- odbun spawns **no** server: not per-workspace `opencode serve` (rejected: old method, many child processes, RAM-heavy), and it never starts, stops, restarts, or replaces the user's service. If the service is down, odbun surfaces its status and points the user to `opencode service start`; auto-start is an opt-in setting, default **off** (§4).
- "Deep" means the **full API surface** — sessions, streaming, catalog, permissions, questions, MCP, steering, interruption, mid-session model switch where the API supports it. It does **not** mean embedding or forking opencode internals. The official GUI/TUI are themselves pure API clients of this service (`packages/cli/src/commands/handlers/run.ts` resolves a server connection before doing anything else), so parity with them is both the ceiling and the proof that the API suffices.
- The integration follows the repo extension policy: **new files plus one registration point** behind the upstream `RuntimeAgentDef` contract, namespaced config (`odbun.*` / `ODBUN_*`), blast radius contained. The anti-pattern is Vela (one integration rooted in 122 daemon source files, parked as V1); P6 is one client module, one runner, and thin wiring (§3).
- Every capability ships **dual-track** (repo `AGENTS.md`): a web UI surface and an `od` CLI surface over the same `/api/*` endpoints.
- The CLI-spawn opencode path (the current def, P1–P4) retires **only** after the service-client path passes the acceptance criteria in §9.4.

**Non-goals:**

- No embedding, linking, or forking of opencode internals; no dependency on `@opencode/*` packages (the wire contract is the dependency, guarded by the CI job in §10).
- No change to the other 18 shipped agent defs, and no change to `byok-opencode` (it keeps the CLI transport; revisiting it is a separate decision).
- No odbun-side replication of opencode configuration: providers, auth, and agent config stay owned by the user's opencode setup (§7).
- No multi-user/team features (that is Vela's parked territory, V1).

---

## 2. Evidence base

Both runs used the pinned opencode **v2.2.5** binary on a clean GitHub Actions runner, driven by the spike client in `port/spikes/opencode-service/` (full record: that directory's `README.md`).

### 2.1 Spike run 1 — free mode (run `42161960763`)

The client discovered the service from its registration file, probed health, read the catalog, created a session, admitted a prompt on a free model of the built-in `opencode` provider, consumed the event stream, re-read the session, and deleted it. **All wire stages passed.** The run stage classified **RUN_ERROR**: the free tier answered HTTP 429 "Free usage limit reached" before any assistant text was produced (settle `session.execution.failed` in 727 ms).

Catalog observed: 1 provider (`opencode`), 8 models, 7 of them free. Variants were populated for 5 models (e.g. DeepSeek/GLM free: `low/high/max`; Flint: `low/medium/high/xhigh/max`) and **empty for 3** (`mimo-v2.6-flash-free`, `nemotron-3.5-lightning-free`, `big-pickle`) — the catalog, not the client, decides whether a model carries variants (§8).

**Proves:** discovery, health, catalog, session create/read/delete, prompt admission, and SSE settling all work against the real service with zero account setup. **Does not prove:** a completed model execution (the 429 intervened), nor anything about a real user's providers.

### 2.2 Spike run 2 — Baseten custom-provider mode (run `42171815258`)

Same client, targeted mode: the runner installed the user's own `baseten-muse` provider config (copied verbatim from his `opencode.jsonc`) as the global opencode config, with the `BASETEN_API_KEY` repo secret passed as env to the service-start step only. Classification: **RUN_OK** — all seven stages passed:

- Catalog: **3 providers** (`opencode`, `baseten`, `baseten-muse`), **23 models**; the target `baseten-muse` / `meta-models/muse-spark-open-1026` was present with variants `low/medium/high/xhigh`.
- Session created with variant `low`; the run settled on `session.execution.succeeded` in **1,722 ms**; assistant text was the requested marker (`SPIKE_OK`); re-read showed outcome `succeeded`, 3 messages.
- Cleanup deleted the session (204) and the job log verified no stray opencode processes remained.

**Proves:** the full service-client loop with a *custom* provider and a real model execution — i.e. the exact P6 integration surface — including per-session variant selection. **Does not prove:** behaviour against the user's live service on his own machine (providers like his Meta-native route, his saved permissions, his project configs), interactive permission/question round-trips, or long-run streaming fidelity. Those are the machine-acceptance gate in §10, not CI claims.

### 2.3 The current CLI path already ends in the same service

Verified in the v2 CLI sources, and load-bearing for §3 and §5: `opencode run` is itself an API client. Its handler (`packages/cli/src/commands/handlers/run.ts`) first calls `ServerConnection.resolve` (`packages/cli/src/services/server-connection.ts`):

- with `--server`, it attaches to that server (health via `/api/info`; a version mismatch only warns);
- with `--standalone` — or when the service is disabled in config — it starts an ephemeral standalone server;
- **by default** it discovers the user's managed service and **ensures** it — `Service.ensure` starts the service if it is not running (`packages/client/src/effect/service.ts`: `discover` never spawns, `ensure` spawns contenders until the service is discoverable) — with the version check ignored under the default mismatch policy (`resolveManaged`, `mismatch: "ignore"`).

The session is then created **in that service, via the API**. So the sessions odbun's CLI path produces today are already real service sessions, visible in the user's opencode app, persisted in the service's shared storage — and odbun's def already relies on exactly that persistence: it captures the `sessionID` from the stream and resumes it with `-s <id>` on follow-up turns (`apps/daemon/src/runtimes/defs/opencode.ts`, `capturesSessionIdFromStream`).

P6's gain is therefore precise: **same destination sessions, direct API instead of a CLI intermediary.** What the intermediary costs today:

- a CLI process spawn, server resolution, and stdout stream parsing **per turn**;
- env-shaping surprises at the spawn site: the daemon strips `OPENCODE`, `OPENCODE_PID`, `OPENCODE_RUN_ID`, and `OPENCODE_SERVER_PASSWORD` from the child env and forces `OPENCODE_DISABLE_PROJECT_CONFIG=true` (`apps/daemon/src/runtimes/env.ts`, opencode branch);
- a discovery blind spot under sandbox mode: the sandbox redirects the child's `HOME` (and XDG dirs) to the sandbox agent home (`apps/daemon/src/sandbox-mode.ts`, `applySandboxRuntimeEnv`), so the child's own service discovery reads the sandbox's empty state dir and misses the user's real service registration entirely (§9);
- catalog discovery (P2) boots a **separate** `opencode serve --stdio` `ServerProcess` per fetch (`fetchOpenCodeModelInfoFromServer` in `defs/opencode.ts`). Every server instance points at the same shared database (`databasePath(global.data)` in `packages/cli/src/server-process.ts`), so its data persists — but it is a second live process whose sessions are not live in the user's running service, spawned just to read a catalog the user's service already has.

---

## 3. Architecture

### 3.1 Components

All new code lives in **one new directory**, `apps/daemon/src/runtimes/opencode-service/`, per the daemon layout rules (new runtime code belongs in `src/runtimes/`):

| File | Responsibility |
|---|---|
| `client.ts` | The service client. Discovery (registration file), probe, and typed wrappers over the v2 API surface P6 uses: info, provider/model catalog, session create/get/list, prompt, interrupt, model switch, permission list/reply, form list/reply, MCP list/add, config get. Bun-native `fetch` only; no new dependencies. The service password is used solely to build the `Authorization` header — never logged, never persisted. |
| `status.ts` | The service status state machine (§4): turns registration + probe results into the snapshot the API, UI, and CLI all render. |
| `demux.ts` | Owns the **single** SSE connection to the service (§3.3): subscribes to `/api/event`, fans events out to per-session subscribers, reconnects with backoff, and triggers state reconciliation after any gap. |
| `runner.ts` | The run backend (§3.2): drives one odbun run over the client — create/resume session, admit prompt, translate service events and messages into the daemon's internal run-event stream, settle the run through the existing run-lifecycle chokepoints. |
| `catalog.ts` | Maps the service catalog (`Provider.Info[]`, `Model.Info[]`) to the daemon's `RuntimeModelOption[]`, reusing the existing normalisation in `defs/opencode.ts` (`parseOpenCodeModelInfo`), and owns the identity-keyed cache (§8). |

Thin wiring in existing files — deliberately the only edits outside the new directory:

- `apps/daemon/src/runtimes/types.ts`: one optional field on `RuntimeAgentDef` (see §3.2).
- `apps/daemon/src/runtimes/defs/opencode.ts`: sets that field; nothing else changes until retirement (§9.4).
- The chat-run pipeline in `apps/daemon/src/server.ts`: one dispatch branch where transports are already selected (the pipeline branches on `def.streamFormat` today, e.g. the `acp-json-rpc` branches).
- `packages/contracts`: one extension of the shared agent-info shape (`AgentInfo`, `packages/contracts/src/api/registry.ts`) carrying the service status summary, so web and CLI render the same thing.
- The existing agent route surface + `apps/daemon/src/cli.ts`: status endpoint consumption and the `od` surface (§4.3).

The registry (`apps/daemon/src/runtimes/registry.ts`, `SHIPPED_AGENT_DEFS`) is **not** touched: P6 adds no new agent entry.

### 3.2 Decision: a transport mode on the existing opencode def, not a separate def

**Decision:** P6 is a second *transport* of the existing `opencode` agent, not a new agent. Concretely:

- `RuntimeAgentDef` gains one optional field, `serviceTransport?: 'opencode-service'`, declared next to the existing transport discriminators. The opencode def sets it. This field is the **one registration point**: it declares "this agent can be driven through the opencode service API".
- Whether the transport is *used* is daemon configuration, namespaced per the extension policy: app-config key `odbun.opencode.transport` (`cli` | `service`, default `cli` until §9.4 acceptance flips it), overridable by env `ODBUN_OPENCODE_TRANSPORT` on the daemon process.
- At run creation, the chat-run pipeline resolves the transport once: if the def declares `serviceTransport`, the resolved mode is `service`, and the service status is `ready`, the run goes to `opencode-service/runner.ts`; otherwise it takes today's spawn path. (No silent mid-run switching; §9.3.)

Justification, from the contract as it actually is:

1. **The contract is spawn-shaped, but transport variation already lives inside it.** `RuntimeAgentDef` (`apps/daemon/src/runtimes/types.ts`) requires `bin`, `buildArgs`, and a `streamFormat`, yet the ACP family (`streamFormat: 'acp-json-rpc'`, `resumesSessionViaAcpLoad`, `acpMcpEnvFormat`, …) and the profile-stdio family are protocol transports that the pipeline branches on — a def is an agent *identity* plus transport behaviour, not necessarily a binary. A service transport is the same kind of variation, expressed the same way.
2. **The sessions are the same sessions.** §2.3: the CLI path's sessions already live in the user's service. A separate def id (say `opencode-service`) would split the session binding (§3.3), the picker entry, and the conversation history of one agent into two, and would force a migration story for zero semantic difference — the destination session store does not change.
3. **Separate defs are for separate product identities.** The one sibling precedent, `byok-opencode`, is a distinct product surface (BYOK routing, custom-model-only), not a transport variant of the same agent.
4. **Retirement stays small.** When §9.4 is met, retiring the CLI path means removing the spawn branch and the def's `buildArgs`/discovery machinery — not a registry or data migration.

The cost, stated plainly: the run pipeline gains one branch, and `runner.ts` must emit the same internal event shapes the `opencode` stream parser produces today so that everything downstream (execution record, usage scanning, artifact outcome) is transport-blind. That translation duty is the runner's whole job, and it is testable in isolation (§10).

### 3.3 Session mapping and persistence

The binding already exists and does not move. The daemon persists capture-style resume handles in the `agent_sessions` table (`apps/daemon/src/db.ts`): primary key `(conversation_id, agent_id)`, the captured `session_id`, and resume-identity guard columns `model` and `cwd` (a change in either forces a fresh session on the CLI path) plus `last_message_id` and `last_input_tokens`. Under P6 the row for `(conversation_id, 'opencode')` keeps exactly this meaning — `session_id` is the opencode service session id — with two refinements:

- **Creation stamps the binding on both sides.** When the runner creates a session it passes `metadata: { "odbun.conversationId": <id>, "odbun.projectId": <id> }`. Session metadata is defined as host-supplied, durable, and opaque to core (`packages/schema/src/session-metadata.ts`: a `Record<string, Json>`; children and forks inherit it). The daemon row stays authoritative; the stamp makes a service-side session self-describing for repair and for the user inspecting their service.
- **The `model` guard relaxes in service mode.** On the CLI path a model change forces a reseed because the CLI resume identity is model-bound. The service API has an explicit operation for this — `POST /api/session/:sessionID/model` with `{model: Model.Ref}` (`packages/protocol/src/groups/session.ts`, `session.switchModel`) — so in service mode a model change is a switch call plus a guard-column update, not a new session. The `cwd` guard keeps its meaning: it is the session's `location.directory`, and a different project directory still means a different session.

Reattach after an odbun restart is then mechanical: for each binding row, `GET /api/session/:sessionID` confirms the session still exists in the (possibly restarted) service, and `GET /api/session/active` reports whether a foreground drain for it is currently owned by the service process — the input to run-restart recovery (§5).

### 3.4 Event demux: one stream per service

`GET /api/event` is **server-wide across all locations**, with an optional `types` filter; the first event is `server.connected` (`packages/protocol/src/groups/event.ts`). The demux therefore holds exactly one SSE connection per *service identity* (the registration's `id` + `url` + `pid`, compared the way the official client's `same()` compares registrations in `packages/client/src/service-probe.ts`), and fans out by the `sessionID` carried in each event's data.

Two contract properties shape the design:

- **The stream is volatile by contract** — "a slow consumer overflows and fails the stream, and events during disconnection are missed" (`event.ts`). So events are a *live hint channel, never the record*. On reconnect, and on any settle ambiguity, the runner reconciles from the projected state (`GET /api/session/:id`, `GET …/message`) — the same read-back pattern the spike used for its re-read stage.
- The event vocabulary is rich enough to drive the UI live: content and reasoning updates (`session.message.content.updated`, `session.reasoning.delta`), step and execution lifecycle (`session.step.*`, `session.execution.started/succeeded/failed/interrupted`), inbox movement (`session.inbox.enqueued/delivered/cancelled`), and the interactive channels (`permission.asked/replied`, `form.created/replied/cancelled`) — `packages/schema/src/session-event.ts`, `packages/schema/src/permission.ts`, `packages/schema/src/form.ts`.

---

## 4. Discovery & lifecycle

### 4.1 Probe semantics — mirror the official client, minus `replace`

The official client's probe (`packages/client/src/service-probe.ts`) reads the registration file (`$XDG_STATE_HOME/opencode/service.json`, default `~/.local/state/opencode/service.json`) holding `{id, version, url, pid, password?}`, then classifies:

- `GET /api/info` answering **404** → the service speaks an **incompatible** health protocol;
- a body that does not decode to `{version: string, pid: integer}`, a **pid mismatch** against the registration, or a version differing from the registration's → not a usable service;
- otherwise state is `ready` (HTTP 200), `failed` (HTTP 500), or `waiting` (anything else).

Its `decide()` then returns `reuse` / `wait` / `fail` / **`replace`** (on a version-requirement mismatch — `matchesVersion` in `packages/client/src/service-version.ts` is exact-equality or a client-supplied predicate). **odbun adopts every branch except `replace`**: replacing the user's service is precisely what the locked decisions forbid. odbun's status machine (`status.ts`) is:

| Status | Condition | Run behaviour |
|---|---|---|
| `unregistered` | no registration file | service transport unavailable; UI/CLI point to `opencode service start` |
| `unreachable` | registration present, probe times out / transport error | unavailable; keep probing on the status cadence |
| `incompatible` | 404 on `/api/info`, undecodable body, or pid mismatch | **fail closed** — runs refused with the reason |
| `waiting` | probe answers but not `ready` | runs wait for `ready` (bounded), mirroring `decide()`'s `wait` |
| `failed` | probe state `failed` (HTTP 500) | unavailable; surfaced verbatim |
| `ready` | pid matches, version matches registration | runs may proceed |

**Version-compat rule.** Two different checks must not be conflated. The probe's internal consistency check (service's reported version must equal its registration's version) is adopted as-is — a mismatch means the registration is stale. A difference between the service's version and the version this odbun build was verified against (the pinned v2.2.5 line) is **not** a hard failure: it mirrors the CLI's `--server` attach behaviour, which warns and continues (`server-connection.ts`). odbun surfaces it as an `untested-version` warning on the status snapshot and proceeds; only protocol incompatibility fails closed. The wire-contract CI job (§10) is what keeps "untested" honest over time.

### 4.2 Lifecycle rules

- The daemon probes lazily (first status request or first service-mode run) and then keeps the snapshot fresh on a slow cadence plus on every identity change of the registration file. It **never** calls anything that starts, stops, restarts, or replaces the service — the client module has no such code path at all (the official client's `ensure`/`replace` machinery is deliberately not mirrored).
- **Auto-start (opt-in, default off):** with app-config `odbun.opencode.autoStart: true`, a run that finds the service `unregistered`/`unreachable` may invoke the *user's own* `opencode service start` CLI once and re-probe. That is the only start path, it is off by default, and there is no stop counterpart.
- If the service identity changes under a live demux (the user restarted or replaced the service), the demux tears down and affected runs fail with a `service-replaced` diagnostic (§9) — never a silent migration of a live run to a new process.

### 4.3 Surfacing

One status snapshot, three renderings (dual-track rule):

- **Daemon API:** the agent surface gains the status (via the contracts `AgentInfo` extension, §3.1): state, service version, url, pid, and the `untested-version` flag.
- **Web UI:** the OpenCode agent card / Settings → Models & providers shows the state in plain language; `unregistered` and `incompatible` states carry the one action the user can take (`opencode service start`, or update/restart the service themselves). odbun offers no button that performs lifecycle actions on the service.
- **`od` CLI:** the same payload with `--json`, following the existing `od <capability>` pattern in `apps/daemon/src/cli.ts`.

## 5. Session & run-semantics mapping

Because the CLI path already terminates in the same service (§2.3), this mapping is a **transport translation**, not a data migration: every odbun concept below already has a service-side counterpart, and the binding (§3.3) is shared. Endpoint citations are to `packages/protocol/src/groups/session.ts` unless noted.

| odbun concept | Today (CLI transport) | Service transport (P6) |
|---|---|---|
| Create session | First `opencode run` spawn mints the session inside the service; daemon captures `sessionID` from the stdout stream | `POST /api/session` with `{title, model: {providerID, id, variant?}, location: {directory}, metadata, permissions}` — the id is returned directly; no stream capture. `id` is `Model.Info.id`, **not** `modelID` (spike-grounded) |
| Prompt admission | Prompt written to the child's stdin at spawn | `POST /api/session/:id/prompt` `{text, delivery?, resume?}` — *durable* admission: the input lands in the session inbox (`SessionInbox`) and execution is scheduled unless `resume: false`. The response is the admitted inbox item, so a prompt is never lost to a transport hiccup after admission |
| Streaming → execution record | `json-event-stream` parser over child stdout (`eventParser: 'opencode'`) | Demux events for the session (`session.message.content.updated`, `session.reasoning.delta`, `session.step.*`, tool content in projected messages) translated by `runner.ts` into the same internal run events the parser emits today; gaps reconciled by re-reading `GET /api/session/:id/message` (volatile-stream rule, §3.4) |
| Steering a live run | Refused for opencode: `classifyRunSteering` (`apps/daemon/src/runtimes/run-steering.ts`) only accepts `stream-json` runtimes with an open stdin — today that is Claude only | Native: a steering message is a prompt POST with `delivery: "steer"` (`packages/schema/src/session-inbox.ts`: `Delivery = "steer" \| "queue"`). Design: in service mode the opencode def reports mid-turn input support (the shared predicate lives in `@open-design/contracts`, `agentSupportsMidTurnSteering` — it gains the service-transport case), and the steer route's verdict feeds the same `POST …/prompt` path instead of a stdin write |
| Queued follow-up | odbun-side queue; sent as the next turn's spawn | A prompt POST with `delivery: "queue"` parks the input in the session inbox; `GET …/inbox` lists parked items, `DELETE …/inbox/:inboxID` cancels one, `PATCH …/inbox/:inboxID` edits one before delivery — a direct map for the UI's queued-send strip, including cancel/edit |
| Interrupt / cancel run | Kill the child process (process-group kill) | `POST /api/session/:id/interrupt` (optional `?resume=`). Returns `{interrupted: boolean}` — `false` means the session was idle or not owned by this service process; the runner then reconciles from `GET /api/session/:id` + the `Idle` message outcome instead of assuming |
| Settle → run finish | Child exit + stream end; finish gated by the run lifecycle (`pendingTerminalFinish` in `apps/daemon/src/runtimes/runs.ts`) | Settle signal is `session.execution.succeeded/failed/interrupted` (or status → idle); the terminal `Idle` message carries `outcome: succeeded \| failed \| interrupted` (`packages/schema/src/session-message.ts`). The runner closes the run through the **same** finish chokepoint and gating as the CLI path — no second finish semantics |
| Usage accounting | The run engine scans recorded run events for per-step `usage` events (`scanRunEventsForUsageAnalytics` in `runs.ts`; "AMR/OpenCode reports provider usage per model step") | The service exposes usage **on the assistant messages themselves**: each `Assistant` message carries optional `cost` (`Money.USD`) and `tokens` (`TokenUsage.Info` = `{input, output, reasoning, cache: {read, write}}`) — `packages/schema/src/session-message.ts`, `packages/schema/src/token-usage.ts`. At settle, the runner reads the turn's assistant messages and synthesises the same internal per-step `usage` events the scanner already consumes, so observability (including the parked usage-recovery domain, §9) is unchanged in shape. Aggregate cross-check available from `GET /api/experimental/session/stats` |
| Resume / reattach after odbun restart | Binding row + `-s <id>` on the next spawn | Binding row + `GET /api/session/:id` (exists?) and `GET /api/session/active` (drain still live in the service?). A run whose execution *completed inside the service while odbun was down* is reconciled from messages and closed by the existing restart-recovery path (`apps/daemon/src/runtimes/run-restart-recovery.ts`) instead of being reported lost |
| Mid-session model switch | Guard column forces a fresh session (transcript reseed) | `POST /api/session/:sessionID/model` with `{model: Model.Ref}`; guard column updated (§3.3) |
| Delete conversation | Binding row cascades away with the conversation (`agent_sessions` FK `ON DELETE CASCADE`); the upstream session is never deleted | **Unchanged by design.** The session belongs to the user's service and stays visible in their app. `DELETE /api/session/:id` exists (deletes child sessions too) but P6 does not call it on conversation or project delete; an explicit per-session delete affordance, if ever wanted, is a separate dual-track feature |
| Artifact detection | Filesystem snapshot diff of the project dir at run start/finish (`snapshotProjectArtifactsAsync`, `apps/daemon/src/run-artifact-fs.ts`), consumed at the run's finalize chokepoint | **Unchanged.** Detection never depended on the transport — it diffs the project directory, and the session's `location.directory` *is* that directory, so produced files land exactly where the snapshot looks |
| Session env for shell tools | Child env shaped by `runtimes/env.ts` | `PUT /api/session/:id/environment` `{variables}` replaces the env used by the session's local shell commands — the service-mode counterpart for the few per-session env needs; daemon-process env shaping does not apply (see §7) |

Available but **out of v1 scope** (recorded so nobody re-derives them): session fork (`POST …/fork`), compaction (`POST …/compact`), session move to another directory (`POST …/move`), export/import (`/api/experimental/session/…`), and `session.wait`. None is needed for parity with the CLI transport.

---

## 6. Permissions & questions

### 6.1 Permissions

**Today (CLI transport), permissions are pre-computed, never interactive.** For each run the daemon builds an ordered v2 ruleset — `{action, resource, effect}` entries, last-match-wins — via `buildOpenCodePermissionsV2` (`apps/daemon/src/mcp-config.ts`), merges it with the run's MCP payload, and hands it to the child as `OPENCODE_CONFIG_CONTENT` at the spawn site (`apps/daemon/src/server.ts`). Separately, when the installed CLI supports it, `--dangerously-skip-permissions` is appended (capability-probed in `apps/daemon/src/runtimes/opencode-permissions.ts`). An `ask` outcome in this world cannot be answered — there is no one to ask; the tool call is auto-rejected (the failure mode `opencode-permissions.ts` documents for ungranted `external_directory` reads: the run "auto-rejects the follow-up read" and the model ends the turn).

**Service transport keeps the same ruleset and adds the missing round-trip:**

1. The runner computes the ruleset with the **same builder** (`buildOpenCodePermissionsV2`) and passes it in the field the API provides for exactly this: `permissions` on `POST /api/session` (a `Permission.Ruleset` — the same ordered-ruleset schema P4 emits), revisable later via `PATCH /api/session/:id`. Nothing about grant policy changes.
2. When evaluation yields `ask` (`Permission.Effect = "allow" \| "deny" \| "ask"`, `packages/schema/src/permission.ts`), the service creates a `Permission.Request` (`{action, resources, save, metadata, source}`) and announces it with the `permission.asked` event. The demux routes it to the run; the daemon renders its existing permission UX; the answer goes back as `POST /api/session/:sessionID/permission/:requestID/reply` with `{decision, message?}` where decision maps 1:1 from the UX: approve once → `"once"`, approve and remember → `"always"`, deny → `"reject"` (`Permission.Reply` literals).
3. `"always"` answers persist **server-side** as saved permissions for the project (the `permission.saved` endpoints list/patch/delete them), which matches the mental model "the agent remembers my choice" and keeps the record in the user's own service, not in odbun.
4. Pending requests are always re-listable (`GET /api/session/:id/permission`, or per-location `GET /api/permission/request`), so a request raised while the UI was closed is recovered by listing, not lost with the event — the same reconcile-don't-trust-the-stream rule as §3.4. Note the one hard edge: reloading a location's configuration **cancels pending permissions and forms** (`POST /api/location/reload` semantics, `packages/protocol/src/groups/location.ts`); the runner surfaces that as a cancelled prompt in the UI rather than a hang.

### 6.2 Questions

odbun's existing question mechanism is prompt-side: the model emits a `<question-form>` artifact, the web app renders it inside the assistant message, and answers return as the next user message (root `AGENTS.md`, "Asking the user questions"). That mechanism stays for the CLI/API transports.

The service has a **native** channel, and P6 uses it in service mode: opencode v2 ships a built-in `question` tool (`packages/core/src/tool/plugin/question.ts`) which, during a run, creates a **session form** through the form service. Forms are structured — typed fields with options and visibility conditions (`packages/schema/src/form.ts`) — and live on the session:

- announced by the `form.created` event (and listable via `GET /api/session/:id/form`);
- fetched in full via `GET /api/session/:id/form/:formID` (`Form.Detail`);
- answered via `POST /api/session/:id/form/:formID/reply` with a `Form.Reply` payload (the endpoint distinguishes already-settled and invalid-answer errors, so the UI can re-render rather than fail);
- cancelled via `DELETE …/form/:formID` with an optional reason message, which is also what the runner calls if the odbun run is cancelled while a form is pending.

**Design rule:** within one run, exactly one question channel is live. In service mode that is the native form channel (rendered by the web UI from the form definition; the `od` CLI renders the same form payload as text/`--json`). The daemon does not translate `<question-form>` artifacts into service forms or vice versa in v1 — the prompt-composition guidance for the service transport steers the model to the `question` tool instead (a prompt-side note in the service runner's system context, not a code bridge).

## 7. Config & MCP inheritance

### 7.1 Verified facts about the CLI transport

1. **The user's global config and env are inherited.** The child is spawned with the daemon-shaped env and an intact `HOME`, so the agent reads its own global config (for opencode: `~/.config/opencode/opencode.json(c)`, its `auth.json`, its providers) exactly as when the user runs it manually.
2. **odbun's own MCP servers are injected per run, without writing user files.** The daemon's persisted external MCP servers (its `.od/mcp-config.json` store, `apps/daemon/src/mcp-config.ts`) plus run-scoped servers are selected per run (`resolveExternalMcpServersForRun` in `apps/daemon/src/run-tool-bundle.ts` — under sandbox mode the persisted set is dropped, run-scoped only) and serialised by `buildOpenCodeMcpConfigContent` into the v2 payload (`{mcp: {servers: {…}}, permissions: […]}`), handed to the child as `OPENCODE_CONFIG_CONTENT` at the spawn site (`apps/daemon/src/server.ts`). Returning `null` (nothing to inject) deliberately leaves the env untouched so the user's saved config is never overridden by an empty object.
3. **Project config is deliberately disabled.** The opencode branch of `runtimes/env.ts` forces `OPENCODE_DISABLE_PROJECT_CONFIG=true` (and strips the `OPENCODE*` server env vars): left enabled, the child's project-config discovery walks up from its cwd and runs a package install at the enclosing root, which corrupts pnpm workspaces. So today: global config yes, project config no.
4. **Sandbox mode is the opt-in full isolation.** `OD_SANDBOX_MODE` redirects `HOME`/XDG/`CODEX_HOME`/`CLAUDE_CONFIG_DIR` into the daemon's sandbox roots (`apps/daemon/src/sandbox-mode.ts`) — the agent then sees none of the user's real config (and, per §2.3, cannot even find the user's service registration).

### 7.2 The service resolves config per location — an explicit decision point

In service mode there is no child env to shape. The **service** resolves configuration for the session's location: config discovery is layered from system, global, and project sources for that directory (`packages/core/src/config/discovery.ts`), and the API exposes the result — `GET /api/config` with a location query returns the configuration documents and discovery sources *for that location, from lowest to highest priority* (`packages/protocol/src/groups/config.ts`). Consequence: **global and project config both apply** — which differs from the CLI transport's deliberate project-config exclusion (§7.1.3).

Options:

- **A. Accept silently.** Matches how the user's own opencode app behaves on the same service, but silently reverses a deliberate odbun behaviour (project config off) — a hidden semantic change. Rejected on those grounds alone.
- **B. Enforce CLI parity (project config off).** Not achievable through the API: there is no per-session or per-location config switch in the protocol; the only config write endpoint is `PATCH /api/experimental/config`, which patches narrow fields of the *global* document (`Config.Patch` carries `shell` only, `packages/schema/src/config.ts`). Parity would require owning the service's config resolution — i.e. not using the user's service. Rejected as impossible under the locked decisions.
- **C. Accept and surface (recommended).** Take the service's semantics, and make the difference *visible*: the run header / agent card shows the effective config sources for the run's location (from `GET /api/config`), and when a project-level `opencode.json(c)` is among them, the UI marks it "project config applies in service mode" — because that is the one place behaviour intentionally differs from the CLI transport. The corruption scenario behind §7.1.3 does not transfer: it was caused by a daemon-spawned child walking up from *its* cwd; the service resolves the location the user themselves runs it with, and their own app usage already exercises the same project configs in the same service. odbun adds no new exposure — but it does not hide the change either.

**Recommendation: C**, recorded here as an open decision for Hadi's sign-off at implementation time (S5, §11); the implementation must not ship A by default through inattention.

### 7.3 odbun's MCP servers in service mode

The API does offer a channel — experimental, and designed for exactly this: `PUT /api/experimental/mcp/:server` with `{config: Mcp.ServerConfig}` and a location query "adds an MCP server at runtime or replaces an existing one, connecting it immediately"; `GET /api/mcp` lists a location's servers with connection status; `DELETE` removes a runtime server *until restart* (`packages/protocol/src/groups/mcp.ts`). Registration is therefore **per location, runtime-only, and non-persistent** — a good fit for per-run injection semantics:

- The bridge reuses the existing selection and shapes: the same per-run server selection as the CLI path (§7.1.2), with each server entry taken from the same builder output — the builder's entries already *are* `Mcp.ServerConfig`-shaped (local: `command: string[]`, `environment`, `disabled`; remote: `url`, `headers`, `disabled` — compare `buildOpenCodeMcpConfigContent` in `mcp-config.ts` with `packages/schema/src/mcp.ts`). Conversion is a per-server PUT, not a new serialiser.
- **Registration rules:** register lazily for a location before its first service-mode run; re-check on service identity change (runtime registrations die with the service process). `GET /api/mcp` first: a name the service already has *from the user's config* is left alone (the PUT would replace it — config wins, bridge skips). The bridge never issues `DELETE`: runtime entries vanish at service restart on their own, and deleting could disturb the user's other clients attached to the same service.
- odbun's own live-artifacts server (`buildLiveArtifactsMcpServersForAgent` in `apps/daemon/src/runtimes/mcp.ts`, today ACP-only) registers through the same channel as a local server in S5.
- Trust note, stated once: for remote servers the builder merges OAuth bearer tokens into headers today; in service mode those headers transit to the user's own service process — the same trust domain as the user's own config files. No new external party is involved.

---

## 8. Catalog & model UX

- **Source of truth:** the service's live catalog — `GET /api/provider` + `GET /api/model`, location-scoped via the location query (`{location: {directory}}`, `packages/protocol/src/groups/location.ts`). Normalisation reuses `parseOpenCodeModelInfo` (`defs/opencode.ts`): entries become `RuntimeModelOption[]`, and each model's `variants` become its `reasoningOptions` — the identical merge P2 performs today against a throwaway `serve --stdio` instance, now read from the service the user actually runs. The P2 probe instance is retired by this (its only job was catalog access).
- **Picker:** unchanged UI, fed from the service catalog in service mode. Because the catalog is the *user's* catalog, custom providers appear automatically with their configured variants — spike run 2 is the proof: `baseten-muse` and its `low/medium/high/xhigh` variants showed up with no odbun-side knowledge of Baseten. This closes the "OpenCode card has no effort control" gap for every variant-bearing model: the variant chosen in the picker is passed structurally in the model ref (`Model.Ref {providerID, id, variant?}`, `packages/schema/src/model.ts`) at session create, or via `session.switchModel` mid-conversation.
- **Refresh & invalidation:** the cache follows the existing remembered-live-models pattern (`apps/daemon/src/runtimes/models.ts`, `getRememberedLiveModels`) but is keyed by **service identity + location directory**; it invalidates on service identity change, on a status transition into `ready`, and is refreshed lazily when the picker opens (stale-while-revalidate, as detection behaves today). A session create that reports an unknown model forces exactly one refresh before failing (§9).
- **Honesty note:** models whose catalog entry carries `variants: []` — router-style models, and 3 of the free models in spike run 1 — get **no** effort control in the picker. odbun does not invent a ladder for them. The remedy lives where it belongs: variants the user defines for a model in their own opencode config (the config schema supports per-model `variants`, `packages/schema/src/config/provider.ts`) flow through the same catalog and appear on the next refresh — exactly how the Baseten model's variants arrived in spike run 2.

## 9. Failure modes & fallback

### 9.1 Failure table

| Failure | Detection | Behaviour |
|---|---|---|
| Service down at run start (`unregistered` / `unreachable` / `failed`) | §4 status machine | The run is refused *before* any session work, with the status and the user's one remedy (`opencode service start`) in the message. With `odbun.opencode.autoStart` on, one start attempt + re-probe first (§4.2). The CLI transport is **not** silently substituted (§9.2) |
| Service incompatible (404 / undecodable / pid mismatch) | probe classification | Fail closed, in status and at run start. This is a protocol problem, not a "try anyway" case |
| Service dies mid-run | SSE stream drops; prompt/interrupt POSTs fail | The run is finished as failed with a `service-lost` diagnostic through the normal finish chokepoint. The *session* is not declared lost: sessions and messages persist in the service's shared storage, so after the user restarts their service, the next turn reattaches to the same session id and reconciles from messages. The interrupted run itself is never silently resurrected |
| User restarts/replaces the service mid-run | registration identity (`id`/`url`/`pid`) changes under the demux | Demux tears down; live runs on the old identity fail with `service-replaced`. A live run is never migrated to a new process behind the user's back — the new service may have a different config and catalog |
| Version drift (service newer/older than the verified line, protocol compatible) | §4.1 version rule | `untested-version` warning on the status snapshot; runs proceed (mirrors the CLI's `--server` warn-and-continue). Only incompatibility fails closed |
| Stale catalog (model in the picker no longer exists) | session create rejects the model | One forced catalog refresh (§8), then fail with the refreshed catalog as evidence — never a retry loop |
| Pending permission/form when the service goes away | the run fails as `service-lost` (above) | Nothing dangles on the odbun side: pending prompts are service-process state and die with it (a config reload cancels them even in the healthy case, §6.1); the UI closes them with the run |
| Sandbox mode + service transport | resolved at run creation | **Unavailable in v1, fail closed with an explicit status.** The sandbox's promise is isolation from the user's real environment; attaching its runs to the user's real service would break that promise (and the CLI transport's sandbox blindness in §2.3 shows the two models do not mix). Sandbox runs keep the CLI transport |

One structural note: the service client always resolves the registration and probes with the **daemon's own** environment — never with a run's shaped child env. The CLI path's env-stripping surprises (§2.3) exist because a child process had to be kept away from the daemon's own opencode-related variables; with no child, that whole class disappears.

### 9.2 No silent fallback

Transport is a configuration fact, not a per-run heuristic. If `odbun.opencode.transport` is `service` and the service is not `ready`, the run refuses (§9.1) — it does not quietly spawn the CLI, because the two transports differ in observable ways the user has a right to expect consistency on (§7.2 config semantics, §6 interactivity). Switching is one explicit settings flip, applies to **new runs only**, and — because the session binding is shared (§3.3) — a conversation continues across the flip on the same underlying opencode session.

### 9.3 Transition posture

Until §9.4 is met, `cli` remains the default and the fully supported path; `service` is opt-in per install. Both transports are exercised in CI (§10) so the fallback cannot rot while it is still the default.

### 9.4 Acceptance criteria for retiring the CLI transport

All of the following, in order; the flip of the default and the S6 removal happen only after 1–4, with 5 as the final human gate:

1. **Wire contract green:** the frozen CI job (§10) passes on the pinned opencode version in free mode (wire stages) and in Baseten mode (`RUN_OK`), including the permission-reply, form-reply, model-switch, and MCP-add stages the later phases rely on.
2. **Parity scenario:** a scripted scenario (multi-turn conversation with a file edit, a steering message, an interrupt, a model switch, and a permission `ask`) produces equivalent odbun-side outcomes on both transports — same produced files, same execution-record structure, usage totals present and plausible on both (exact token equality is *not* required; the accounting shape must match).
3. **Machine acceptance:** on Hadi's machine, against his real providers (Baseten custom provider, Meta-native route, Fireworks router), one full design run through odbun completes via the service transport, including a permission round-trip and a question-form round-trip.
4. **Recovery drills:** daemon restart mid-run and service restart between turns both reconcile as specified in §5/§9.1, demonstrated in the CI harness or on the machine.
5. **Sign-off:** Hadi flips `odbun.opencode.transport` to `service` for daily use and confirms; only then does S6 schedule the removal.

---

## 10. Testing strategy

- **Freeze the spike into a permanent wire-contract CI job.** The existing workflow (`.github/workflows/odbun-opencode-spike.yml`) becomes the contract job: dispatchable, run on any change to the pinned opencode version, and on a weekly schedule. Free mode keeps today's gating (wire stages gate; the run classification is data, because the free tier's 429 is not a contract break). Baseten mode (secret present) gates on `RUN_OK`. Before S4/S5 build on them, the harness grows stages for the additional surface this design uses — permission reply, form reply, `session.switchModel`, `mcp.add` — so every load-bearing endpoint in §5–§7 is exercised against the real binary, per the Actions-first rule (heavy work on runners; the VM orchestrates).
- **Focused daemon tests** under `apps/daemon/tests/runtimes/opencode-service/` (repo layout: package-level `tests/`, source-only `src/`): probe classification against recorded registration/info fixture pairs covering every §4 row; demux filtering, identity-change teardown, and reconnect-reconcile against a shape-faithful stub service (the pattern the spike already validated locally); runner usage synthesis from recorded message payloads; catalog mapping reusing the existing `parseOpenCodeModelInfo` fixtures. Focused tests locally; full daemon/web suites in CI, per repo rules — never locally.
- **Parity scenario** (§9.4.2) lives in the CI harness as a scripted two-transport comparison, not as a unit test.
- **Machine acceptance is the final gate** (§9.4.3): Actions proves the contract; Hadi's machine proves his providers. No claim about his live service is made from CI evidence.

---

## 11. Implementation plan

Stream + worktree pattern: one branch per phase, disjoint file ownership, merged one at a time.

| Phase | Contents | Files | Exit evidence |
|---|---|---|---|
| **S1 — client + status** | `client.ts` (discovery/probe/API wrappers), `status.ts` state machine. No wiring anywhere | new: `apps/daemon/src/runtimes/opencode-service/{client,status}.ts`; tests in `apps/daemon/tests/runtimes/opencode-service/` | Focused tests green; every §4 status row reproduced from fixtures |
| **S2 — runner + demux + dispatch** | `demux.ts`, `runner.ts` (create/resume, prompt, steer via `delivery`, interrupt, settle→finish with usage synthesis); transport config key; one dispatch branch in the chat-run pipeline; `serviceTransport` field on the def | new: `…/opencode-service/{demux,runner}.ts`; edits: `runtimes/types.ts`, `runtimes/defs/opencode.ts`, `server.ts` (one branch), app-config | CI integration: daemon drives a run against a runner-hosted pinned service; run completes, usage recorded, steering and interrupt exercised |
| **S3 — status surfacing + catalog** | `catalog.ts`; contracts `AgentInfo` extension; web agent card + picker fed by the service catalog; `od` CLI status surface | new: `…/opencode-service/catalog.ts`; edits: `packages/contracts`, `apps/web` (agent settings surface), `apps/daemon/src/cli.ts`, agent route surface | All §4 states render identically in UI and `od --json`; picker shows service catalog incl. variants from a stub service |
| **S4 — permissions & questions bridge** | permission.asked routing + reply, saved-permission mapping; form.created routing + reply/cancel; web renderers for both | edits: `…/opencode-service/runner.ts`, `apps/web` (chat permission/question surfaces) | Scripted `ask` round-trip and `question`-tool form round-trip pass in the CI harness (Baseten mode), including cancel paths |
| **S5 — MCP bridge + config surfacing** | per-location `mcp.add` registration with the §7.3 rules; live-artifacts registration; effective-config display + project-config marker (§7.2 option C) | edits: `…/opencode-service/client.ts` (mcp/config calls), runner, `apps/web` run header | odbun's servers listed by `GET /api/mcp` for the location and callable in a run; config sources for the location displayed; decision C implemented as designed |
| **S6 — CLI retirement** | flip the default transport to `service`; remove the opencode spawn branch, P2's `serve --stdio` discovery, and CLI-only opencode machinery that nothing else uses; registry/porting notes updated (P1–P4 marked superseded by P6) | edits: `runtimes/defs/opencode.ts`, `server.ts`, `runtimes/env.ts` (opencode branch), `port/port-items.json`, `PORTING.md` | §9.4 criteria 1–5 all on record; full suites green in CI |

---

## 12. Unverified / open probes

Each item below was **not** verified from sources during design; each names the probe that settles it. None blocks S1; S2–S5 must settle the ones in their scope before relying on them.

1. **Tool-event fidelity.** Whether service messages/events expose tool inputs/outputs (incl. file diffs) at the fidelity the CLI path's injected event plugin provides (`apps/daemon/src/runtimes/opencode-event-plugin.ts`, consumed by `opencode-tool-events.ts`). *Probe:* run the same file-editing task over both transports against a fixture service; diff the resulting execution records.
2. **Content-delta payloads.** Event *names* for live content are verified (`session.message.content.updated`, `session.reasoning.delta`), but their payload shapes and frequency are not recorded. *Probe:* capture the full SSE of a Baseten-mode run with a long generation; inspect the payloads and rate.
3. **`switchModel` on a busy session.** The protocol states no busy constraint; behaviour mid-drain is unknown. *Probe:* call `session.switchModel` during an active long run in the harness; record acceptance vs error and which model the next step uses.
4. **Usage completeness on errored/retried steps.** `Assistant.cost`/`tokens` are optional and retry records exist (`AssistantRetry`). *Probe:* force a provider error mid-run; inspect the turn's messages for usage presence and define the synthesiser's tolerance before S2 relies on totals.
5. **`mcp.add` replace semantics.** Whether a PUT over a *config-defined* server of the same name shadows it, and whether DELETE then restores the config definition. *Probe:* harness scenario — config defines server X; PUT X; GET; DELETE X; GET after each step.
6. **Permission `ask` coverage.** Whether MCP-tool calls and external-directory accesses raise `Permission.Request`s identically to built-in tools in service mode. *Probe:* run under an `ask` ruleset with an ungranted external-dir read and an MCP tool call; observe `permission.asked` for both.
7. **`session.list` filter fields.** `SessionsQuery` embeds a `Session.ListFilter` whose fields were not read; a binding-repair scan across projects may want them. *Probe:* read `ListFilter` in `packages/schema/src/session.ts` and exercise a filtered list against a multi-project service.
8. **Catalog location-sensitivity.** Whether `GET /api/model` differs per directory when a project config adds a provider. *Probe:* two directories, one with a project `opencode.json` defining a provider; compare catalogs.
9. **Form answer error shapes.** `Form.Reply` is schema-defined and invalid answers map to `FormInvalidAnswerError`, but the error's payload shape (per-field detail?) is unrecorded — the UI needs it for re-render. *Probe:* reply with a deliberately invalid answer in the harness; record the error body.
10. **`session.active` after a service restart.** Its description scopes it to drains "owned by this OpenCode process"; the post-restart picture (sessions persist, drains gone) is inferred, not exercised. *Probe:* restart the service mid-run in the harness; record `session.active`, `session.get`, and message state.

---

## 13. Registry note

`port/port-items.json` gains the entry `{id: "P6", file: "P6-DESIGN.md", status: "designed", summary: …}` and `"P6"` is appended to the `order` array. "Designed" is the honest status: the design is complete and evidence-grounded; no implementation has landed. P1–P4 remain `landed` — they describe the live CLI transport — and are re-marked as superseded by P6 only when S6 (§11) actually retires that transport.
