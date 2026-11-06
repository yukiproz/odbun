// OpenCode service client (P6, design: port/P6-DESIGN.md §3–§5).
//
// A client for the user's own opencode v2 background service — the daemon
// registered by `opencode service start` — spoken to exactly the way the
// official client speaks to it: discover via the registration file, probe
// `GET /api/info`, then call the v2 HTTP API with HTTP Basic auth
// (`opencode:<password>` from the registration).
//
// Wire behaviour mirrors the proven spike (port/spikes/opencode-service/,
// two green Actions runs) and the official client's probe
// (packages/client/src/service-probe.ts in the opencode v2 reference tree),
// with one deliberate omission: this module has NO lifecycle surface. It
// never starts, stops, restarts, replaces, or ensures a service process —
// there is no spawn call and no code path that could grow one. §4.2: the
// service belongs to the user; odbun only observes and talks to it.
//
// The service password is used solely to build the `Authorization` header.
// It is never logged, never persisted, and never copied into thrown errors
// or returned objects: error messages are built from method/path/status
// only, and response bodies are never embedded in them.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Contents of the local service registration file. */
export interface OpenCodeServiceRegistration {
  /** Unique service instance identifier. */
  id?: string;
  /** OpenCode version the service process reported when it registered. */
  version?: string;
  /** Base URL advertised by the service. */
  url: string;
  /** Operating system process identifier of the service. */
  pid: number;
  /** Private service password, when authentication is enabled. */
  password?: string;
}

/** The registration minus the credential — safe to hand to other layers. */
export type OpenCodeServiceTarget = Omit<OpenCodeServiceRegistration, 'password'>;

/**
 * Outcome of reading the registration file. Expected absence cases are
 * typed results, never thrown errors.
 */
export type RegistrationRead =
  | { kind: 'found'; registration: OpenCodeServiceRegistration }
  | { kind: 'missing' }
  | { kind: 'malformed'; detail: string };

export type ProbeClassification = 'ready' | 'failed' | 'waiting' | 'incompatible' | 'unreachable';

export interface ProbeResult {
  classification: ProbeClassification;
  /** Version the service itself reported on `/api/info`, when it decoded. */
  serverVersion?: string;
  /** HTTP status of the probe response, when a response arrived. */
  httpStatus?: number;
  /** Human-readable reason for non-`ready` outcomes. Never carries secrets. */
  reason?: string;
}

export type OpenCodeModelRef = {
  providerID: string;
  /** `Model.Info.id` — NOT `modelID` (design §5, spike-grounded). */
  id: string;
  variant?: string;
};

export interface OpenCodeProviderInfo {
  id: string;
  name: string;
}

export interface OpenCodeModelVariant {
  id: string;
}

export interface OpenCodeModelInfo {
  /** `Model.Info.id` — the id used in {@link OpenCodeModelRef}. */
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  variants: OpenCodeModelVariant[];
}

export interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

export type OpenCodePermissionRuleset = OpenCodePermissionRule[];

export interface OpenCodeSessionInfo {
  id: string;
  parentID?: string;
  projectID?: string;
  agent?: string;
  model?: OpenCodeModelRef;
  title?: string;
  location: { directory: string };
  metadata?: Record<string, unknown>;
  /** Outcome of the last completed execution, once a run has settled. */
  outcome?: 'succeeded' | 'failed' | 'interrupted';
}

export interface CreateSessionInput {
  title?: string;
  model?: OpenCodeModelRef;
  location: { directory: string };
  /** Host-supplied, durable, opaque to core (design §3.3). */
  metadata?: Record<string, unknown>;
  permissions?: OpenCodePermissionRuleset;
}

export type OpenCodePromptDelivery = 'steer' | 'queue';

export interface PromptSessionInput {
  text: string;
  delivery?: OpenCodePromptDelivery;
  /** `false` admits the input without scheduling execution. */
  resume?: boolean;
}

/** The admitted inbox item returned by a prompt call (SessionInbox.User). */
export interface OpenCodeInboxUserItem {
  id: string;
  type: 'user';
  delivery: OpenCodePromptDelivery;
  payload: { text: string };
}

export interface OpenCodeSessionMessageContent {
  type: string;
  text?: string;
}

export interface OpenCodeSessionMessage {
  id?: string;
  type: string;
  content?: OpenCodeSessionMessageContent[];
  error?: unknown;
}

export type OpenCodeServiceErrorKind = 'transport' | 'http' | 'decode';

/**
 * Every failure this module raises deliberately. The message is composed
 * from the request method, path, and (for HTTP failures) the status only —
 * never from headers, credentials, or response bodies — so a surfaced
 * error can always be logged or rendered verbatim.
 */
export class OpenCodeServiceError extends Error {
  readonly kind: OpenCodeServiceErrorKind;
  readonly status?: number;
  readonly method?: string;
  readonly path?: string;

  constructor(
    kind: OpenCodeServiceErrorKind,
    message: string,
    context: { status?: number; method?: string; path?: string } = {},
  ) {
    super(message);
    this.name = 'OpenCodeServiceError';
    this.kind = kind;
    if (context.status !== undefined) this.status = context.status;
    if (context.method !== undefined) this.method = context.method;
    if (context.path !== undefined) this.path = context.path;
  }
}

export interface OpenCodeServiceClientOptions {
  /** Absolute registration file path. Overrides XDG resolution. */
  registrationFile?: string;
  /** Environment used for XDG resolution. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Fetch implementation. Defaults to the global `fetch` (Bun-native). */
  fetchImpl?: typeof fetch;
  /** Default per-request timeout. Defaults to 15 s (the spike's default). */
  requestTimeoutMs?: number;
  /** Probe timeout. Defaults to 10 s (the spike's probe budget). */
  probeTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
/** Session create / prompt admission outlive a plain read on a cold service. */
const DEFAULT_MUTATION_TIMEOUT_MS = 30_000;

/**
 * Registration file resolution, mirroring the official client
 * (`service-probe.ts` `fallback()`): an explicit file wins, otherwise
 * `$XDG_STATE_HOME/opencode/service.json`, defaulting to
 * `~/.local/state/opencode/service.json`. The official client exposes no
 * further env override, so neither does this one.
 */
export function resolveRegistrationPath(options: { file?: string; env?: NodeJS.ProcessEnv } = {}): string {
  if (options.file !== undefined) return options.file;
  const env = options.env ?? process.env;
  const stateHome = env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(stateHome, 'opencode', 'service.json');
}

/**
 * Boundary validation for the registration file, mirroring `Info` in the
 * official client's `service.ts`: `url` and `pid` are the load-bearing
 * fields; `id`, `version`, and `password` ride along when they are
 * strings. Returns `undefined` for anything that is not a usable
 * registration.
 */
export function parseRegistration(raw: unknown): OpenCodeServiceRegistration | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.url !== 'string' || candidate.url.length === 0) return undefined;
  if (typeof candidate.pid !== 'number' || !Number.isInteger(candidate.pid) || candidate.pid < 0) {
    return undefined;
  }
  const registration: OpenCodeServiceRegistration = { url: candidate.url, pid: candidate.pid };
  if (typeof candidate.id === 'string') registration.id = candidate.id;
  if (typeof candidate.version === 'string') registration.version = candidate.version;
  if (typeof candidate.password === 'string') registration.password = candidate.password;
  return registration;
}

/** Why a parsed-as-JSON registration is unusable, naming fields only. */
function registrationProblem(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return 'registration is not a JSON object';
  const candidate = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof candidate.url !== 'string' || candidate.url.length === 0) {
    problems.push('missing string `url`');
  }
  if (typeof candidate.pid !== 'number' || !Number.isInteger(candidate.pid) || candidate.pid < 0) {
    problems.push('missing integer `pid`');
  }
  return problems.length > 0 ? problems.join('; ') : 'registration failed validation';
}

/**
 * Whether two registrations describe the same service instance — mirrors
 * the official client's `same()`. The status tracker and (in S2) the event
 * demux use it to detect that the user restarted or replaced the service.
 */
export function sameServiceIdentity(
  left: OpenCodeServiceRegistration,
  right: OpenCodeServiceRegistration,
): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.url === right.url &&
    left.pid === right.pid
  );
}

/** Decode a `/api/info` body the way the official client's probe does. */
function decodeServerInfo(body: unknown): { version: string; pid: number } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.version !== 'string') return undefined;
  if (typeof candidate.pid !== 'number' || !Number.isInteger(candidate.pid) || candidate.pid < 0) {
    return undefined;
  }
  return { version: candidate.version, pid: candidate.pid };
}

function authorizationHeaders(registration: OpenCodeServiceRegistration): Record<string, string> {
  if (registration.password === undefined) return {};
  return {
    authorization: 'Basic ' + Buffer.from(`opencode:${registration.password}`).toString('base64'),
  };
}

/**
 * A bound view of one registered service: the typed API wrappers plus the
 * generic request core they are built on. Later protocol groups (design
 * Appendix A.3) are new wrappers over {@link OpenCodeServiceConnection.requestJson},
 * not new plumbing.
 */
export interface OpenCodeServiceConnection {
  /** The service target, without the credential. */
  readonly target: OpenCodeServiceTarget;
  /**
   * Generic request core: one authenticated request to `path` on the
   * service base URL, resolving with the parsed JSON body (`undefined` for
   * an empty body). Throws {@link OpenCodeServiceError} on transport
   * failure, JSON decode failure, or a non-2xx status.
   */
  requestJson(
    method: string,
    path: string,
    options?: { body?: unknown; timeoutMs?: number; accept?: string },
  ): Promise<unknown>;
  /** `GET /api/info`, strictly decoded. */
  info(): Promise<{ version: string; pid: number }>;
  /** `GET /api/provider` — the active providers for the default location. */
  listProviders(): Promise<OpenCodeProviderInfo[]>;
  /** `GET /api/model` — the model catalog snapshot for the default location. */
  listModels(): Promise<OpenCodeModelInfo[]>;
  /** `POST /api/session`. */
  createSession(input: CreateSessionInput): Promise<OpenCodeSessionInfo>;
  /** `GET /api/session/:sessionID`. */
  getSession(sessionID: string): Promise<OpenCodeSessionInfo>;
  /** `GET /api/session`. */
  listSessions(): Promise<OpenCodeSessionInfo[]>;
  /** `POST /api/session/:sessionID/prompt` — resolves with the admitted inbox item. */
  prompt(sessionID: string, input: PromptSessionInput): Promise<OpenCodeInboxUserItem>;
  /** `GET /api/session/:sessionID/message` — the projected messages. */
  listMessages(sessionID: string): Promise<OpenCodeSessionMessage[]>;
  /**
   * `GET /api/event` — opens the server-wide SSE stream and returns the
   * raw response (status + body stream) for the S2 demux to consume. No
   * `types` filter is sent: its query encoding is unverified, and the
   * demux fans out locally anyway (design §3.4). Long-lived by nature, so
   * no module-side timeout applies — pass an `AbortSignal` to close it.
   */
  openEventStream(options?: { signal?: AbortSignal }): Promise<Response>;
}

export class OpenCodeServiceClient {
  private readonly resolvedRegistrationPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly probeTimeoutMs: number;

  constructor(options: OpenCodeServiceClientOptions = {}) {
    this.resolvedRegistrationPath = resolveRegistrationPath({
      ...(options.registrationFile !== undefined ? { file: options.registrationFile } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  /** The registration file this client reads. */
  get registrationPath(): string {
    return this.resolvedRegistrationPath;
  }

  /**
   * Read and validate the registration file. A missing file is `missing`,
   * unreadable/invalid content is `malformed` with a field-level detail —
   * neither throws. Malformed details name fields only, never file
   * contents, so they are safe to surface (a truncated file could contain
   * a partial credential).
   */
  async readRegistration(): Promise<RegistrationRead> {
    const path = this.registrationPath;
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'malformed', detail: 'registration file unreadable' };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: 'malformed', detail: 'registration file is not valid JSON' };
    }
    const registration = parseRegistration(raw);
    if (registration === undefined) {
      return { kind: 'malformed', detail: registrationProblem(raw) };
    }
    return { kind: 'found', registration };
  }

  /**
   * Probe classification, exactly per design §4.1 (the official client's
   * probe, minus any `decide()`/replace machinery):
   *
   * - timeout / transport error → `unreachable`
   * - `GET /api/info` answering 404 → `incompatible`
   * - body not decoding to `{version: string, pid: integer}` → `incompatible`
   * - pid mismatch against the registration → `incompatible`
   * - version differing from the registration's → `incompatible` (stale registration)
   * - HTTP 200 → `ready`; HTTP 500 → `failed`; anything else → `waiting`
   */
  async probe(registration: OpenCodeServiceRegistration): Promise<ProbeResult> {
    const base = registration.url.replace(/\/+$/, '');
    let response: Response;
    try {
      response = await this.fetchImpl(`${base}/api/info`, {
        method: 'GET',
        headers: authorizationHeaders(registration),
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      });
    } catch {
      return {
        classification: 'unreachable',
        reason: 'probe timed out or the service could not be reached',
      };
    }
    const httpStatus = response.status;
    if (httpStatus === 404) {
      return {
        classification: 'incompatible',
        httpStatus,
        reason: '/api/info answered 404 — the service speaks an incompatible health protocol',
      };
    }
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      body = undefined;
    }
    const serverInfo = decodeServerInfo(body);
    if (serverInfo === undefined) {
      return {
        classification: 'incompatible',
        httpStatus,
        reason: '/api/info did not decode to { version: string, pid: integer }',
      };
    }
    if (serverInfo.pid !== registration.pid) {
      return {
        classification: 'incompatible',
        httpStatus,
        serverVersion: serverInfo.version,
        reason: 'service pid differs from the registration — the registration is stale',
      };
    }
    if (registration.version !== undefined && serverInfo.version !== registration.version) {
      return {
        classification: 'incompatible',
        httpStatus,
        serverVersion: serverInfo.version,
        reason: 'service version differs from the registration — the registration is stale',
      };
    }
    if (httpStatus === 200) {
      return { classification: 'ready', httpStatus, serverVersion: serverInfo.version };
    }
    if (httpStatus === 500) {
      return {
        classification: 'failed',
        httpStatus,
        serverVersion: serverInfo.version,
        reason: 'service reported a startup failure (HTTP 500)',
      };
    }
    return {
      classification: 'waiting',
      httpStatus,
      serverVersion: serverInfo.version,
      reason: `service answered HTTP ${httpStatus} — still starting`,
    };
  }

  /** Bind the typed API wrappers to one discovered registration. */
  connect(registration: OpenCodeServiceRegistration): OpenCodeServiceConnection {
    return new ServiceConnection(registration, {
      fetchImpl: this.fetchImpl,
      requestTimeoutMs: this.requestTimeoutMs,
    });
  }
}

class ServiceConnection implements OpenCodeServiceConnection {
  readonly target: OpenCodeServiceTarget;
  private readonly registration: OpenCodeServiceRegistration;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(
    registration: OpenCodeServiceRegistration,
    options: { fetchImpl: typeof fetch; requestTimeoutMs: number },
  ) {
    this.registration = registration;
    const { password: _password, ...target } = registration;
    this.target = target;
    this.base = registration.url.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl;
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  async requestJson(
    method: string,
    path: string,
    options: { body?: unknown; timeoutMs?: number; accept?: string } = {},
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          ...authorizationHeaders(this.registration),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.accept === undefined ? {} : { accept: options.accept }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? this.requestTimeoutMs),
      });
    } catch {
      throw new OpenCodeServiceError(
        'transport',
        `opencode service request failed: ${method} ${path} (transport error)`,
        { method, path },
      );
    }
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new OpenCodeServiceError(
        'http',
        `opencode service request failed: ${method} ${path} answered HTTP ${response.status}`,
        { status: response.status, method, path },
      );
    }
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new OpenCodeServiceError(
        'decode',
        `opencode service request failed: ${method} ${path} did not answer JSON`,
        { status: response.status, method, path },
      );
    }
  }

  /** Unwrap the `{…, data}` envelope every P6 endpoint answers with. */
  private async requestData(
    method: string,
    path: string,
    options: { body?: unknown; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const envelope = await this.requestJson(method, path, options);
    if (typeof envelope !== 'object' || envelope === null || !('data' in envelope)) {
      throw new OpenCodeServiceError(
        'decode',
        `opencode service request failed: ${method} ${path} answered without a data envelope`,
        { method, path },
      );
    }
    return (envelope as { data: unknown }).data;
  }

  async info(): Promise<{ version: string; pid: number }> {
    const data = await this.requestJson('GET', '/api/info');
    const decoded = decodeServerInfo(data);
    if (decoded === undefined) {
      throw new OpenCodeServiceError(
        'decode',
        'opencode service request failed: GET /api/info did not decode to { version: string, pid: integer }',
        { method: 'GET', path: '/api/info' },
      );
    }
    return decoded;
  }

  async listProviders(): Promise<OpenCodeProviderInfo[]> {
    const data = await this.requestData('GET', '/api/provider');
    if (!Array.isArray(data)) {
      throw new OpenCodeServiceError(
        'decode',
        'opencode service request failed: GET /api/provider did not answer an array',
        { method: 'GET', path: '/api/provider' },
      );
    }
    const providers: OpenCodeProviderInfo[] = [];
    for (const item of data) {
      if (typeof item !== 'object' || item === null) continue;
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') continue;
      providers.push({ id: candidate.id, name: candidate.name });
    }
    return providers;
  }

  async listModels(): Promise<OpenCodeModelInfo[]> {
    const data = await this.requestData('GET', '/api/model');
    if (!Array.isArray(data)) {
      throw new OpenCodeServiceError(
        'decode',
        'opencode service request failed: GET /api/model did not answer an array',
        { method: 'GET', path: '/api/model' },
      );
    }
    const models: OpenCodeModelInfo[] = [];
    for (const item of data) {
      if (typeof item !== 'object' || item === null) continue;
      const candidate = item as Record<string, unknown>;
      if (
        typeof candidate.id !== 'string' ||
        typeof candidate.modelID !== 'string' ||
        typeof candidate.providerID !== 'string'
      ) {
        continue;
      }
      const variants: OpenCodeModelVariant[] = [];
      if (Array.isArray(candidate.variants)) {
        for (const variant of candidate.variants) {
          if (typeof variant !== 'object' || variant === null) continue;
          const variantID = (variant as Record<string, unknown>).id;
          if (typeof variantID === 'string') variants.push({ id: variantID });
        }
      }
      models.push({
        id: candidate.id,
        modelID: candidate.modelID,
        providerID: candidate.providerID,
        name: typeof candidate.name === 'string' ? candidate.name : candidate.modelID,
        variants,
      });
    }
    return models;
  }

  async createSession(input: CreateSessionInput): Promise<OpenCodeSessionInfo> {
    const body: Record<string, unknown> = { location: { directory: input.location.directory } };
    if (input.title !== undefined) body.title = input.title;
    if (input.model !== undefined) body.model = input.model;
    if (input.metadata !== undefined) body.metadata = input.metadata;
    if (input.permissions !== undefined) body.permissions = input.permissions;
    const data = await this.requestData('POST', '/api/session', {
      body,
      timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS,
    });
    return decodeSessionInfo(data, 'POST', '/api/session');
  }

  async getSession(sessionID: string): Promise<OpenCodeSessionInfo> {
    const path = `/api/session/${encodeURIComponent(sessionID)}`;
    const data = await this.requestData('GET', path);
    return decodeSessionInfo(data, 'GET', path);
  }

  async listSessions(): Promise<OpenCodeSessionInfo[]> {
    const data = await this.requestData('GET', '/api/session');
    if (!Array.isArray(data)) {
      throw new OpenCodeServiceError(
        'decode',
        'opencode service request failed: GET /api/session did not answer an array',
        { method: 'GET', path: '/api/session' },
      );
    }
    return data.map((item) => decodeSessionInfo(item, 'GET', '/api/session'));
  }

  async prompt(sessionID: string, input: PromptSessionInput): Promise<OpenCodeInboxUserItem> {
    const path = `/api/session/${encodeURIComponent(sessionID)}/prompt`;
    const body: Record<string, unknown> = { text: input.text };
    if (input.delivery !== undefined) body.delivery = input.delivery;
    if (input.resume !== undefined) body.resume = input.resume;
    const data = await this.requestData('POST', path, {
      body,
      timeoutMs: DEFAULT_MUTATION_TIMEOUT_MS,
    });
    if (typeof data !== 'object' || data === null) {
      throw new OpenCodeServiceError(
        'decode',
        `opencode service request failed: POST ${path} did not answer an inbox item`,
        { method: 'POST', path },
      );
    }
    const item = data as Record<string, unknown>;
    if (typeof item.id !== 'string') {
      throw new OpenCodeServiceError(
        'decode',
        `opencode service request failed: POST ${path} answered an inbox item without an id`,
        { method: 'POST', path },
      );
    }
    const payload = typeof item.payload === 'object' && item.payload !== null
      ? (item.payload as Record<string, unknown>)
      : {};
    return {
      id: item.id,
      type: 'user',
      delivery: item.delivery === 'queue' ? 'queue' : 'steer',
      payload: { text: typeof payload.text === 'string' ? payload.text : input.text },
    };
  }

  async listMessages(sessionID: string): Promise<OpenCodeSessionMessage[]> {
    const path = `/api/session/${encodeURIComponent(sessionID)}/message`;
    const data = await this.requestData('GET', path);
    if (!Array.isArray(data)) {
      throw new OpenCodeServiceError(
        'decode',
        `opencode service request failed: GET ${path} did not answer an array`,
        { method: 'GET', path },
      );
    }
    const messages: OpenCodeSessionMessage[] = [];
    for (const item of data) {
      if (typeof item !== 'object' || item === null) continue;
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.type !== 'string') continue;
      const message: OpenCodeSessionMessage = { type: candidate.type };
      if (typeof candidate.id === 'string') message.id = candidate.id;
      if (Array.isArray(candidate.content)) {
        message.content = candidate.content
          .filter(
            (part): part is Record<string, unknown> =>
              typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>).type === 'string',
          )
          .map((part) => {
            const content: OpenCodeSessionMessageContent = { type: part.type as string };
            if (typeof part.text === 'string') content.text = part.text;
            return content;
          });
      }
      if ('error' in candidate) message.error = candidate.error;
      messages.push(message);
    }
    return messages;
  }

  async openEventStream(options: { signal?: AbortSignal } = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}/api/event`, {
        method: 'GET',
        headers: { ...authorizationHeaders(this.registration), accept: 'text/event-stream' },
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch {
      throw new OpenCodeServiceError(
        'transport',
        'opencode service request failed: GET /api/event (transport error)',
        { method: 'GET', path: '/api/event' },
      );
    }
    if (response.status < 200 || response.status >= 300 || response.body === null) {
      throw new OpenCodeServiceError(
        'http',
        `opencode service request failed: GET /api/event answered HTTP ${response.status}`,
        { status: response.status, method: 'GET', path: '/api/event' },
      );
    }
    return response;
  }
}

/** Validate the one field every session consumer keys on, then pass the projected shape through. */
function decodeSessionInfo(data: unknown, method: string, path: string): OpenCodeSessionInfo {
  if (typeof data !== 'object' || data === null) {
    throw new OpenCodeServiceError(
      'decode',
      `opencode service request failed: ${method} ${path} did not answer a session`,
      { method, path },
    );
  }
  const candidate = data as Record<string, unknown>;
  if (typeof candidate.id !== 'string') {
    throw new OpenCodeServiceError(
      'decode',
      `opencode service request failed: ${method} ${path} answered a session without an id`,
      { method, path },
    );
  }
  return data as OpenCodeSessionInfo;
}
