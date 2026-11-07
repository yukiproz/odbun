// OpenCode service status machine (P6, design: port/P6-DESIGN.md §4).
//
// Turns registration + probe results into the one status snapshot the
// daemon API, the web UI, and the `od` CLI all render (§4.3 — surfacing
// lands in S3; this module only owns the snapshot and its freshness).
//
// Freshness model (§4.2): the tracker probes lazily — the first probe
// happens when `start()` (or an explicit `refresh()`) is called — then
// re-probes on a slow cadence. Every cycle re-reads the registration file
// before probing, so a registration identity change (the user restarted
// or replaced the service: new id/pid/url) is probed against the NEW
// registration in that same cycle; a caller with a file watcher can also
// call `refresh()` the moment the file changes. The tracker never starts,
// stops, or replaces the service — there is intentionally no such method.

import {
  sameServiceIdentity,
  type OpenCodeServiceRegistration,
  type ProbeResult,
  type RegistrationRead,
} from './client.js';

/**
 * The service version line this odbun build is verified against:
 * v2.2.6, proven by the 2026-11-07 OpenRouter spike (Actions run
 * 42353229039 — RUN_OK, model `openrouter/free`, wire gate OK; the
 * spike and the wire-contract CI job pin it). A service reporting any
 * other version is NOT a failure — see `untestedVersion` on the
 * snapshot.
 */
export const PINNED_SERVICE_VERSION = '2.2.6';

export type OpenCodeServiceState =
  | 'unregistered'
  | 'unreachable'
  | 'incompatible'
  | 'waiting'
  | 'failed'
  | 'ready';

export interface OpenCodeServiceStatusSnapshot {
  state: OpenCodeServiceState;
  /** The service's own reported version, when known. */
  serviceVersion?: string;
  url?: string;
  pid?: number;
  /**
   * Version-compat warning (§4.1): the service's version differs from the
   * pinned verified line. Mirrors the CLI's `--server` attach behaviour —
   * warn and continue. Only protocol incompatibility fails closed.
   */
  untestedVersion: boolean;
  /** Human-readable detail for non-`ready` states. Never carries secrets. */
  reason?: string;
}

/** The narrow slice of the client the tracker depends on. */
export interface OpenCodeServiceStatusSource {
  readRegistration(): Promise<RegistrationRead>;
  probe(registration: OpenCodeServiceRegistration): Promise<ProbeResult>;
}

export interface OpenCodeServiceStatusTrackerOptions {
  /** Standing re-probe cadence. Defaults to 30 s — slow on purpose (§4.2). */
  refreshIntervalMs?: number;
  /** Verified version line for the `untestedVersion` flag. */
  pinnedVersion?: string;
  /** Injectable clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

const UNREGISTERED_HINT = 'start the service with `opencode service start`';

/**
 * The pure mapping from one discovery + probe cycle to a snapshot.
 * Exported so the mapping is testable without timers.
 */
export function resolveStatusSnapshot(input: {
  read: RegistrationRead;
  probe?: ProbeResult;
  pinnedVersion?: string;
}): OpenCodeServiceStatusSnapshot {
  const pinnedVersion = input.pinnedVersion ?? PINNED_SERVICE_VERSION;
  const { read } = input;
  if (read.kind === 'missing') {
    return {
      state: 'unregistered',
      untestedVersion: false,
      reason: `no service registration file — ${UNREGISTERED_HINT}`,
    };
  }
  if (read.kind === 'malformed') {
    return {
      state: 'unregistered',
      untestedVersion: false,
      reason: `service registration unusable (${read.detail}) — ${UNREGISTERED_HINT}`,
    };
  }
  const registration = read.registration;
  const probe = input.probe;
  if (probe === undefined) {
    return {
      state: 'unreachable',
      url: registration.url,
      pid: registration.pid,
      ...(registration.version !== undefined ? { serviceVersion: registration.version } : {}),
      untestedVersion:
        registration.version !== undefined && registration.version !== pinnedVersion,
      reason: 'registered service has not been probed yet',
    };
  }
  const serviceVersion = probe.serverVersion ?? registration.version;
  const snapshot: OpenCodeServiceStatusSnapshot = {
    state: probe.classification,
    url: registration.url,
    pid: registration.pid,
    untestedVersion: serviceVersion !== undefined && serviceVersion !== pinnedVersion,
  };
  if (serviceVersion !== undefined) snapshot.serviceVersion = serviceVersion;
  if (probe.reason !== undefined) snapshot.reason = probe.reason;
  return snapshot;
}

export class OpenCodeServiceStatusTracker {
  private readonly source: OpenCodeServiceStatusSource;
  private readonly refreshIntervalMs: number;
  private readonly pinnedVersion: string;
  private readonly now: () => number;
  private readonly listeners = new Set<(snapshot: OpenCodeServiceStatusSnapshot) => void>();

  private snapshot: OpenCodeServiceStatusSnapshot = {
    state: 'unregistered',
    untestedVersion: false,
    reason: 'not probed yet',
  };
  private lastRegistration: OpenCodeServiceRegistration | undefined;
  private lastIdentityChanged = false;
  private lastRefreshedAt: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<OpenCodeServiceStatusSnapshot> | undefined;

  constructor(source: OpenCodeServiceStatusSource, options: OpenCodeServiceStatusTrackerOptions = {}) {
    this.source = source;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.pinnedVersion = options.pinnedVersion ?? PINNED_SERVICE_VERSION;
    this.now = options.now ?? Date.now;
  }

  /** The latest snapshot. Before the first probe completes it is the `not probed yet` placeholder. */
  getSnapshot(): OpenCodeServiceStatusSnapshot {
    return this.snapshot;
  }

  /** When the last probe cycle completed, per the injected clock. */
  getLastRefreshedAt(): number | undefined {
    return this.lastRefreshedAt;
  }

  /** Whether the most recent cycle saw a different service identity than the one before it. */
  getLastIdentityChanged(): boolean {
    return this.lastIdentityChanged;
  }

  /** Be notified when the snapshot actually changes. Returns an unsubscribe function. */
  subscribe(listener: (snapshot: OpenCodeServiceStatusSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Begin lazy probing: one cycle immediately, then one per cadence tick.
   * Idempotent. The timer is unref'd where the runtime supports it, so a
   * tracker can never keep a process alive on its own.
   */
  start(): void {
    if (this.timer !== undefined) return;
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Stop the cadence. An in-flight cycle, if any, still completes. */
  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Run one probe cycle now. Concurrent calls share the in-flight cycle. */
  refresh(): Promise<OpenCodeServiceStatusSnapshot> {
    if (this.inFlight !== undefined) return this.inFlight;
    const cycle = this.runCycle().finally(() => {
      if (this.inFlight === cycle) this.inFlight = undefined;
    });
    this.inFlight = cycle;
    return cycle;
  }

  private async runCycle(): Promise<OpenCodeServiceStatusSnapshot> {
    const read = await this.source.readRegistration();
    let probe: ProbeResult | undefined;
    if (read.kind === 'found') {
      const previous = this.lastRegistration;
      this.lastIdentityChanged =
        previous !== undefined && !sameServiceIdentity(previous, read.registration);
      probe = await this.source.probe(read.registration);
      this.lastRegistration = read.registration;
    } else {
      this.lastIdentityChanged = this.lastRegistration !== undefined;
      this.lastRegistration = undefined;
    }
    const next = resolveStatusSnapshot({
      read,
      ...(probe !== undefined ? { probe } : {}),
      pinnedVersion: this.pinnedVersion,
    });
    this.lastRefreshedAt = this.now();
    const changed = JSON.stringify(next) !== JSON.stringify(this.snapshot);
    this.snapshot = next;
    if (changed) {
      for (const listener of this.listeners) listener(next);
    }
    return this.snapshot;
  }
}
