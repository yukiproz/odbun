// Spike P6 — drive the opencode v2 *user service* (the daemon registered by
// `opencode service start`) exactly the way the official client does:
// discover via the registration file, probe /api/info, read the catalog,
// create a session, run one tiny prompt on a free model, consume the event
// stream, re-read the session, clean up.
//
// Grounding (opencode v2.2.5 reference tree, packages/):
//   registration file + probe semantics — client/src/service.ts,
//     client/src/service-probe.ts (GET /api/info, Basic auth
//     "opencode:<password>" from the registration file)
//   endpoints — protocol/src/groups/{session,message,event,model,provider}.ts
//     POST   /api/session                 { location: { directory }, model?, title? }
//     POST   /api/session/:id/prompt      { text }
//     GET    /api/session/:id             GET /api/session/:id/message
//     DELETE /api/session/:id
//     GET    /api/event                   (SSE; first event: server.connected)
//     GET    /api/model                   -> { location, data: Model.Info[] }
//     GET    /api/provider                -> { location, data: Provider.Info[] }
//   payload shapes — schema/src/{location,model,prompt-input,session,
//     session-message,session-status-event,session-event}.ts
//     Model.Ref.id matches Model.Info.id (core/src/model-resolver.ts);
//     assistant text lives in message.content[] items tagged "text";
//     a run settles on session.execution.succeeded/failed/interrupted or
//     session.status -> idle for the session.
//
// Run: bun port/spikes/opencode-service/spike-client.ts
// Report: port/spikes/opencode-service/report.json (env SPIKE_REPORT wins).
// Exit: 0 when stages discover/health/catalog/session-create/session-reread
// pass. The run stage is data (RUN_OK | AUTH_REQUIRED | RUN_ERROR), never
// pass/fail — answering the auth question is the point.
//
// Modes:
//   free (default) — run a free model of the built-in `opencode`
//     provider; run stage is named "run-free-model".
//   targeted (SPIKE_PROVIDER set, with SPIKE_MODEL / SPIKE_VARIANT) —
//     run that exact catalog model instead; run stage is named
//     "run-model". The workflow targets OpenRouter's free router
//     model (provider `openrouter`, model `openrouter/free`, no
//     variant): OpenRouter is a built-in provider, so no config is
//     installed — the service process inherits OPENROUTER_API_KEY
//     from its env and resolves it directly. This client never reads
//     or logs any provider credential.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

type Stage = { stage: string; ok: boolean; detail: Record<string, unknown> };
type Info = { id?: string; version?: string; url: string; pid: number; password?: string };
type ModelInfo = {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  variants?: Array<{ id: string }>;
};
type ChosenModel = { providerID: string; id: string; modelID: string; name: string };

const stages: Stage[] = [];
const record = (stage: string, ok: boolean, detail: Record<string, unknown>) => {
  stages.push({ stage, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${stage} — ${brief(detail)}`);
};
const skipFrom = (names: string[], reason: string) => {
  for (const name of names) record(name, false, { skipped: reason });
};
function brief(detail: Record<string, unknown>): string {
  const first = Object.entries(detail)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return first.length > 220 ? first.slice(0, 220) + "…" : first;
}

/** Bounded, key-only view of an unknown error-ish value (no payload dumps). */
function shapeOf(value: unknown): Record<string, unknown> {
  if (value instanceof Error) return { kind: "Error", name: value.name, message: value.message.slice(0, 300) };
  if (typeof value === "string") return { kind: "string", text: value.slice(0, 300) };
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = { kind: "object", keys: Object.keys(obj).slice(0, 12) };
    for (const key of ["name", "message", "code", "status", "title"]) {
      if (typeof obj[key] === "string") out[key] = (obj[key] as string).slice(0, 300);
      if (typeof obj[key] === "number") out[key] = obj[key];
    }
    return out;
  }
  return { kind: typeof value };
}
function flattenText(value: unknown): string {
  try {
    return (JSON.stringify(value) ?? "").slice(0, 4000);
  } catch {
    return String(value).slice(0, 4000);
  }
}
const AUTH_PATTERN = /auth|unauthor|forbidden|log ?in|sign[ -]?in|credential|api[ -]?key|payment|billing/i;

// Targeted (custom-provider) mode — see header. Absent envs = free mode,
// with all pre-existing behaviour preserved.
const spikeProvider = process.env.SPIKE_PROVIDER || undefined;
const spikeModel = process.env.SPIKE_MODEL || undefined;
const spikeVariant = process.env.SPIKE_VARIANT || undefined;
const targeted = spikeProvider !== undefined;
const runStageName = targeted ? "run-model" : "run-free-model";

const registrationPath = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
  "opencode",
  "service.json",
);
const reportPath = process.env.SPIKE_REPORT ?? join(process.cwd(), "port/spikes/opencode-service/report.json");

let info: Info | undefined;
let headers: Record<string, string> = {};
let base = "";
let chosen: ChosenModel | undefined;
let sessionID: string | undefined;
let workdir = "";
let runClassification: string | undefined;

const api = (path: string) => `${base}${path}`;
async function request(
  method: string,
  path: string,
  init: { body?: unknown; timeout?: number; accept?: string } = {},
): Promise<{ status: number; json: unknown; text: string }> {
  const response = await fetch(api(path), {
    method,
    headers: {
      ...headers,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.accept === undefined ? {} : { accept: init.accept }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeout ?? 15_000),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}
const dataOf = (json: unknown): Record<string, unknown> | undefined =>
  typeof json === "object" && json !== null ? (json as Record<string, unknown>) : undefined;

// ---------------------------------------------------------------- discover
try {
  const raw = await Bun.file(registrationPath).json();
  const candidate = raw as Partial<Info>;
  if (typeof candidate.url !== "string" || typeof candidate.pid !== "number") {
    record("discover", false, {
      file: registrationPath,
      error: "registration file parsed but lacks a string url / numeric pid",
      keys: Object.keys(candidate ?? {}),
    });
  } else {
    info = candidate as Info;
    base = info.url.replace(/\/$/, "");
    headers =
      info.password === undefined
        ? {}
        : { authorization: "Basic " + Buffer.from(`opencode:${info.password}`).toString("base64") };
    record("discover", true, {
      file: registrationPath,
      url: info.url,
      pid: info.pid,
      version: info.version ?? null,
      id: info.id ?? null,
      hasPassword: info.password !== undefined,
    });
  }
} catch (error) {
  record("discover", false, {
    file: registrationPath,
    error: `registration file unreadable: ${error instanceof Error ? error.message : String(error)}`,
  });
}

if (info === undefined) {
  skipFrom(["health", "catalog", "session-create", runStageName, "session-reread", "cleanup"], "discovery failed");
} else {
  // ------------------------------------------------------------------ health
  // Mirrors service-probe.ts probeResult(): GET /api/info, body must decode
  // to { version: string, pid: integer } and the pid must match the file.
  let healthy = false;
  try {
    const res = await request("GET", "/api/info", { timeout: 10_000 });
    const body = dataOf(res.json);
    const version = typeof body?.version === "string" ? body.version : undefined;
    const pid = typeof body?.pid === "number" && Number.isInteger(body.pid) ? body.pid : undefined;
    const state =
      res.status === 404
        ? "incompatible"
        : version === undefined || pid === undefined
          ? "undecodable"
          : pid !== info.pid
            ? "pid-mismatch"
            : res.status === 200
              ? "ready"
              : res.status === 500
                ? "failed"
                : "waiting";
    healthy = state === "ready";
    record("health", healthy, {
      status: res.status,
      state,
      version: version ?? null,
      pid: pid ?? null,
      registrationVersion: info.version ?? null,
      bodyKeys: body === undefined ? [] : Object.keys(body).slice(0, 12),
    });
  } catch (error) {
    record("health", false, { error: `probe failed: ${error instanceof Error ? error.message : String(error)}` });
  }

  if (!healthy) {
    skipFrom(["catalog", "session-create", runStageName, "session-reread", "cleanup"], "health probe not ready");
  } else {
    // ---------------------------------------------------------------- catalog
    // The snapshot may precede initial plugin settlement (model.list
    // annotation), so poll until the run model shows up or the budget
    // runs out. Targeted mode polls longer (180 s): a custom provider's
    // aisdk package may need to be fetched on first load.
    let providers: Array<{ id: string; name: string }> = [];
    let models: ModelInfo[] = [];
    let freeModels: ModelInfo[] = [];
    let targetModels: ModelInfo[] = [];
    let attempts = 0;
    let catalogError: Record<string, unknown> | undefined;
    const deadline = Date.now() + (targeted ? 180_000 : 90_000);
    const isFree = (m: ModelInfo) =>
      m.providerID === "opencode" && (/free/i.test(m.id) || /free/i.test(m.modelID) || /free/i.test(m.name));
    const isTarget = (m: ModelInfo) =>
      targeted && m.providerID === spikeProvider && (m.modelID === spikeModel || m.id === spikeModel);
    while (true) {
      attempts++;
      try {
        const [providerRes, modelRes] = await Promise.all([
          request("GET", "/api/provider"),
          request("GET", "/api/model"),
        ]);
        if (providerRes.status !== 200 || modelRes.status !== 200) {
          catalogError = { providerStatus: providerRes.status, modelStatus: modelRes.status };
        } else {
          catalogError = undefined;
          const providerData = dataOf(providerRes.json)?.data;
          const modelData = dataOf(modelRes.json)?.data;
          providers = Array.isArray(providerData) ? (providerData as Array<{ id: string; name: string }>) : [];
          models = Array.isArray(modelData) ? (modelData as ModelInfo[]) : [];
          freeModels = models.filter(isFree);
          targetModels = models.filter(isTarget);
        }
      } catch (error) {
        catalogError = { error: error instanceof Error ? error.message : String(error) };
      }
      if (targeted) {
        if (targetModels.length > 0 || Date.now() >= deadline) break;
      } else {
        if (freeModels.length > 0 || Date.now() >= deadline) break;
        if (attempts >= 3 && models.length > 0 && catalogError === undefined) break; // settled, just no free tier
      }
      await Bun.sleep(3_000);
    }
    const toSample = (m: ModelInfo) => ({
      ref: `${m.providerID}/${m.id}`,
      variantIds: (m.variants ?? []).map((v) => v.id),
    });
    const variantSample = [
      ...targetModels.map(toSample),
      ...[...freeModels, ...models.filter((m) => !isFree(m)).slice(0, 5)]
        .map(toSample)
        .filter((s) => !targetModels.some((m) => `${m.providerID}/${m.id}` === s.ref)),
    ];
    if (targeted) {
      const target = targetModels[0];
      if (target !== undefined) {
        chosen = {
          providerID: target.providerID,
          id: target.id,
          modelID: target.modelID,
          name: target.name,
        };
      }
    } else {
      const preferred =
        freeModels.find((m) => /deepseek/i.test(`${m.id} ${m.name}`) && /flash/i.test(`${m.id} ${m.name}`)) ??
        freeModels[0];
      if (preferred !== undefined) {
        chosen = {
          providerID: preferred.providerID,
          id: preferred.id,
          modelID: preferred.modelID,
          name: preferred.name,
        };
      }
    }
    const catalogOk = catalogError === undefined && (providers.length > 0 || models.length > 0);
    record("catalog", catalogOk, {
      attempts,
      providerCount: providers.length,
      providerIds: providers.map((p) => p.id).slice(0, 20),
      modelCount: models.length,
      freeModels: freeModels.map((m) => ({ id: m.id, modelID: m.modelID, name: m.name })),
      ...(targeted
        ? {
            targetProvider: spikeProvider ?? null,
            targetModel: spikeModel ?? null,
            targetVariant: spikeVariant ?? null,
            targetModels: targetModels.map((m) => ({ id: m.id, modelID: m.modelID, name: m.name })),
          }
        : {}),
      variantSample,
      chosen: chosen ?? null,
      ...(catalogError === undefined ? {} : { error: catalogError }),
    });

    // ---------------------------------------------------------- session-create
    workdir = mkdtempSync(join(tmpdir(), "odbun-spike-"));
    try {
      const res = await request("POST", "/api/session", {
        body: {
          title: "odbun P6 spike (opencode service)",
          location: { directory: workdir },
          ...(chosen === undefined
            ? {}
            : {
                model: {
                  providerID: chosen.providerID,
                  id: chosen.id,
                  ...(spikeVariant === undefined ? {} : { variant: spikeVariant }),
                },
              }),
        },
        timeout: 30_000,
      });
      const data = dataOf(res.json)?.data as Record<string, unknown> | undefined;
      if (res.status === 200 && typeof data?.id === "string") {
        sessionID = data.id;
        record("session-create", true, {
          status: res.status,
          sessionID,
          directory: workdir,
          model: data.model ?? null,
          location: data.location ?? null,
        });
      } else {
        record("session-create", false, {
          status: res.status,
          directory: workdir,
          error: shapeOf(res.json ?? res.text),
        });
      }
    } catch (error) {
      record("session-create", false, {
        directory: workdir,
        error: `request failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    if (sessionID === undefined) {
      skipFrom([runStageName, "session-reread", "cleanup"], "no session was created");
    } else {
      // ------------------------------------------------------------ run (model)
      const runDetail: Record<string, unknown> = { model: chosen ?? null };
      if (chosen === undefined) {
        runClassification = "RUN_ERROR";
        runDetail.reason = targeted
          ? `catalog exposed no target model ${spikeProvider}/${spikeModel}`
          : "catalog exposed no free model on the built-in opencode provider";
        record(runStageName, false, { classification: runClassification, ...runDetail });
      } else {
        const counts = new Map<string, number>();
        const sequence: string[] = [];
        let settle: string | null = null;
        let failedError: unknown;
        let streamStatus: number | undefined;
        const controller = new AbortController();
        const TIMEOUT_MS = 120_000;
        const started = Date.now();
        let openResolve: () => void = () => {};
        const opened = new Promise<void>((resolve) => (openResolve = resolve));
        const consume = (async () => {
          try {
            const response = await fetch(api("/api/event"), {
              headers: { ...headers, accept: "text/event-stream" },
              signal: controller.signal,
            });
            streamStatus = response.status;
            openResolve();
            if (!response.ok || response.body === null) return;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (settle === null) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
              let cut = buffer.indexOf("\n\n");
              while (cut >= 0) {
                const block = buffer.slice(0, cut);
                buffer = buffer.slice(cut + 2);
                const dataText = block
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trim())
                  .join("\n");
                if (dataText.length > 0) {
                  try {
                    const event = JSON.parse(dataText) as {
                      type?: string;
                      data?: Record<string, unknown>;
                      sessionID?: string;
                    };
                    if (typeof event.type === "string") {
                      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
                      if (sequence[sequence.length - 1] !== event.type) sequence.push(event.type);
                      const eventSession = event.data?.sessionID ?? event.sessionID;
                      if (eventSession === sessionID) {
                        if (event.type === "session.execution.succeeded") settle = "succeeded";
                        else if (event.type === "session.execution.failed") {
                          settle = "failed";
                          failedError = event.data?.error;
                        } else if (event.type === "session.execution.interrupted") settle = "interrupted";
                        else if (event.type === "session.idle") settle = settle ?? "idle";
                        else if (
                          event.type === "session.status" &&
                          (event.data?.status as { type?: string } | undefined)?.type === "idle"
                        )
                          settle = settle ?? "idle";
                      }
                    }
                  } catch {
                    // Non-JSON data line (heartbeat/comment framing) — ignore.
                  }
                }
                cut = buffer.indexOf("\n\n");
                if (settle !== null) break;
              }
            }
          } catch {
            // Abort (settle or timeout) and transport errors both land here;
            // the outcome is classified from settle + messages below.
          }
        })();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        await opened;
        let promptStatus: number | undefined;
        let promptError: unknown;
        try {
          const res = await request("POST", `/api/session/${sessionID}/prompt`, {
            body: { text: "Reply with exactly: SPIKE_OK" },
            timeout: 30_000,
          });
          promptStatus = res.status;
          if (res.status !== 200) promptError = res.json ?? res.text;
        } catch (error) {
          // A prompt POST that outlives its timeout can still be executing
          // server-side; the event stream + messages decide the outcome.
          promptError = { promptPost: error instanceof Error ? error.message : String(error) };
        }
        await consume;
        clearTimeout(timer);
        const elapsedMs = Date.now() - started;

        // Final assistant text from the projected messages.
        let assistantText = "";
        let assistantError: unknown;
        try {
          const res = await request("GET", `/api/session/${sessionID}/message`);
          const list = dataOf(res.json)?.data;
          if (Array.isArray(list)) {
            const assistants = list.filter(
              (m) => typeof m === "object" && m !== null && (m as { type?: string }).type === "assistant",
            ) as Array<{ content?: Array<{ type: string; text?: string }>; error?: unknown }>;
            const last = assistants[assistants.length - 1];
            if (last !== undefined) {
              assistantText = (last.content ?? [])
                .filter((part) => part.type === "text" && typeof part.text === "string")
                .map((part) => part.text)
                .join("");
              assistantError = last.error;
            }
          }
        } catch {
          // Messages unreadable — classification falls back to events only.
        }

        const errorText = [failedError, assistantError, promptError].map(flattenText).join(" ");
        if (promptStatus === 401 || promptStatus === 403) runClassification = "AUTH_REQUIRED";
        else if (settle === "succeeded" || assistantText.length > 0) runClassification = "RUN_OK";
        else if (AUTH_PATTERN.test(errorText)) runClassification = "AUTH_REQUIRED";
        else runClassification = "RUN_ERROR";

        record(runStageName, runClassification === "RUN_OK", {
          classification: runClassification,
          ...runDetail,
          streamStatus: streamStatus ?? null,
          promptStatus: promptStatus ?? null,
          settleSignal: settle,
          timedOut: settle === null && elapsedMs >= TIMEOUT_MS - 1_000,
          elapsedMs,
          eventCounts: Object.fromEntries(counts),
          eventSequence: sequence,
          spikeOkSeen: assistantText.includes("SPIKE_OK"),
          assistantText: assistantText.slice(0, 200),
          ...(failedError === undefined ? {} : { executionError: shapeOf(failedError) }),
          ...(assistantError === undefined ? {} : { assistantError: shapeOf(assistantError) }),
          ...(promptError === undefined ? {} : { promptError: shapeOf(promptError) }),
        });
      }

      // ---------------------------------------------------------- session-reread
      try {
        const [sessionRes, messageRes] = await Promise.all([
          request("GET", `/api/session/${sessionID}`),
          request("GET", `/api/session/${sessionID}/message`),
        ]);
        const sessionData = dataOf(sessionRes.json)?.data as Record<string, unknown> | undefined;
        const list = dataOf(messageRes.json)?.data;
        const messages = Array.isArray(list) ? list : [];
        const contentCount = messages.reduce((total, m) => {
          const content = (m as { content?: unknown[] }).content;
          return total + (Array.isArray(content) ? content.length : 0);
        }, 0);
        const messageTypes = messages.reduce<Record<string, number>>((acc, m) => {
          const type = (m as { type?: string }).type ?? "unknown";
          acc[type] = (acc[type] ?? 0) + 1;
          return acc;
        }, {});
        record(
          "session-reread",
          sessionRes.status === 200 && sessionData?.id === sessionID && messageRes.status === 200,
          {
            sessionStatus: sessionRes.status,
            outcome: sessionData?.outcome ?? null,
            messageStatus: messageRes.status,
            messageCount: messages.length,
            contentCount,
            messageTypes,
          },
        );
      } catch (error) {
        record("session-reread", false, {
          error: `request failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      // ---------------------------------------------------------------- cleanup
      try {
        const res = await request("DELETE", `/api/session/${sessionID}`);
        record("cleanup", res.status === 204 || res.status === 200 || res.status === 404, {
          status: res.status,
          sessionID,
          ...(res.status === 404 ? { note: "session already gone" } : {}),
        });
      } catch (error) {
        record("cleanup", false, {
          sessionID,
          error: `request failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
}

const gateStages = ["discover", "health", "catalog", "session-create", "session-reread"];
const gateOk = gateStages.every((name) => stages.find((s) => s.stage === name)?.ok === true);
const report = {
  spike: "p6-opencode-service",
  generatedAt: new Date().toISOString(),
  registrationFile: registrationPath,
  service:
    info === undefined
      ? null
      : { url: info.url, pid: info.pid, version: info.version ?? null, id: info.id ?? null },
  workdir: workdir === "" ? null : workdir,
  chosenModel: chosen ?? null,
  targetProvider: spikeProvider ?? null,
  targetModel: spikeModel ?? null,
  targetVariant: spikeVariant ?? null,
  sessionID: sessionID ?? null,
  runClassification: runClassification ?? null,
  stages,
  gateOk,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(
  `\nspike report → ${reportPath}\nrun classification: ${runClassification ?? "n/a"} · wire gate: ${gateOk ? "OK" : "BROKEN"}`,
);
process.exit(gateOk ? 0 : 1);
