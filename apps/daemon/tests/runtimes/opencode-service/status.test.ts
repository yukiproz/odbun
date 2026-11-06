import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  OpenCodeServiceRegistration,
  ProbeResult,
  RegistrationRead,
} from '../../../src/runtimes/opencode-service/client.js';
import {
  OpenCodeServiceStatusTracker,
  resolveStatusSnapshot,
  type OpenCodeServiceStatusSource,
} from '../../../src/runtimes/opencode-service/status.js';

const REGISTRATION: OpenCodeServiceRegistration = {
  id: 'svc-1',
  version: '2.2.5',
  url: 'http://127.0.0.1:49152',
  pid: 4242,
};

const found = (registration: OpenCodeServiceRegistration = REGISTRATION): RegistrationRead => ({
  kind: 'found',
  registration,
});

const readyProbe: ProbeResult = { classification: 'ready', httpStatus: 200, serverVersion: '2.2.5' };

describe('resolveStatusSnapshot — §4 status rows', () => {
  it('unregistered: no registration file', () => {
    const snapshot = resolveStatusSnapshot({ read: { kind: 'missing' } });
    expect(snapshot.state).toBe('unregistered');
    expect(snapshot.reason).toContain('opencode service start');
    expect(snapshot.untestedVersion).toBe(false);
  });

  it('unregistered: malformed registration, detail surfaced', () => {
    const snapshot = resolveStatusSnapshot({
      read: { kind: 'malformed', detail: 'missing integer `pid`' },
    });
    expect(snapshot.state).toBe('unregistered');
    expect(snapshot.reason).toContain('missing integer `pid`');
  });

  it('unreachable: probe timed out / transport error', () => {
    const snapshot = resolveStatusSnapshot({
      read: found(),
      probe: { classification: 'unreachable', reason: 'probe timed out' },
    });
    expect(snapshot.state).toBe('unreachable');
    expect(snapshot.url).toBe(REGISTRATION.url);
    expect(snapshot.pid).toBe(REGISTRATION.pid);
    // Falls back to the registration's claimed version.
    expect(snapshot.serviceVersion).toBe('2.2.5');
  });

  it('incompatible: probe classification passes through, failing closed', () => {
    const snapshot = resolveStatusSnapshot({
      read: found(),
      probe: { classification: 'incompatible', httpStatus: 404, reason: 'incompatible health protocol' },
    });
    expect(snapshot.state).toBe('incompatible');
    expect(snapshot.reason).toContain('incompatible health protocol');
  });

  it('waiting: probe classification passes through', () => {
    const snapshot = resolveStatusSnapshot({
      read: found(),
      probe: { classification: 'waiting', httpStatus: 503, serverVersion: '2.2.5' },
    });
    expect(snapshot.state).toBe('waiting');
  });

  it('failed: probe classification passes through', () => {
    const snapshot = resolveStatusSnapshot({
      read: found(),
      probe: { classification: 'failed', httpStatus: 500, serverVersion: '2.2.5' },
    });
    expect(snapshot.state).toBe('failed');
  });

  it('ready: pinned version is not flagged as untested', () => {
    const snapshot = resolveStatusSnapshot({ read: found(), probe: readyProbe });
    expect(snapshot.state).toBe('ready');
    expect(snapshot.serviceVersion).toBe('2.2.5');
    expect(snapshot.untestedVersion).toBe(false);
    expect(snapshot.reason).toBeUndefined();
  });

  it('ready + untested version: a different service version warns, never fails', () => {
    const snapshot = resolveStatusSnapshot({
      read: found({ ...REGISTRATION, version: '2.3.1' }),
      probe: { classification: 'ready', httpStatus: 200, serverVersion: '2.3.1' },
    });
    expect(snapshot.state).toBe('ready');
    expect(snapshot.serviceVersion).toBe('2.3.1');
    expect(snapshot.untestedVersion).toBe(true);
  });

  it('registered but not yet probed: unreachable with the registration identity', () => {
    const snapshot = resolveStatusSnapshot({ read: found() });
    expect(snapshot.state).toBe('unreachable');
    expect(snapshot.reason).toContain('not been probed');
    expect(snapshot.url).toBe(REGISTRATION.url);
  });
});

/** A scripted status source: each refresh consumes the next scripted cycle. */
function scriptedSource(cycles: Array<{ read: RegistrationRead; probe?: ProbeResult }>) {
  const probedWith: OpenCodeServiceRegistration[] = [];
  let index = 0;
  const source: OpenCodeServiceStatusSource = {
    readRegistration: async () => {
      const cycle = cycles[Math.min(index, cycles.length - 1)];
      index += 1;
      return cycle?.read ?? { kind: 'missing' };
    },
    probe: async (registration) => {
      probedWith.push(registration);
      const cycle = cycles[Math.max(0, Math.min(index - 1, cycles.length - 1))];
      return cycle?.probe ?? readyProbe;
    },
  };
  return { source, probedWith, cyclesRead: () => index };
}

describe('OpenCodeServiceStatusTracker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts on the not-probed placeholder', () => {
    const { source } = scriptedSource([{ read: { kind: 'missing' } }]);
    const tracker = new OpenCodeServiceStatusTracker(source);
    expect(tracker.getSnapshot()).toEqual({
      state: 'unregistered',
      untestedVersion: false,
      reason: 'not probed yet',
    });
    expect(tracker.getLastRefreshedAt()).toBeUndefined();
  });

  it('refresh maps a missing registration to unregistered and stamps the injected clock', async () => {
    const { source } = scriptedSource([{ read: { kind: 'missing' } }]);
    const tracker = new OpenCodeServiceStatusTracker(source, { now: () => 1234 });
    const snapshot = await tracker.refresh();
    expect(snapshot.state).toBe('unregistered');
    expect(tracker.getLastRefreshedAt()).toBe(1234);
  });

  it('refresh probes the discovered registration and lands on ready', async () => {
    const { source, probedWith } = scriptedSource([{ read: found(), probe: readyProbe }]);
    const tracker = new OpenCodeServiceStatusTracker(source);
    const snapshot = await tracker.refresh();
    expect(snapshot.state).toBe('ready');
    expect(snapshot.serviceVersion).toBe('2.2.5');
    expect(probedWith).toEqual([REGISTRATION]);
    expect(tracker.getLastIdentityChanged()).toBe(false);
  });

  it('re-probes the NEW registration when the file identity changes', async () => {
    const replacement: OpenCodeServiceRegistration = { ...REGISTRATION, id: 'svc-2', pid: 7777 };
    const { source, probedWith } = scriptedSource([
      { read: found(), probe: readyProbe },
      { read: found(replacement), probe: readyProbe },
      { read: found(replacement), probe: readyProbe },
    ]);
    const tracker = new OpenCodeServiceStatusTracker(source);

    await tracker.refresh();
    expect(tracker.getLastIdentityChanged()).toBe(false);

    const snapshot = await tracker.refresh();
    expect(probedWith[1]).toEqual(replacement);
    expect(snapshot.pid).toBe(7777);
    expect(tracker.getLastIdentityChanged()).toBe(true);

    await tracker.refresh();
    expect(tracker.getLastIdentityChanged()).toBe(false);
  });

  it('notifies subscribers only when the snapshot actually changes', async () => {
    const { source } = scriptedSource([
      { read: { kind: 'missing' } },
      { read: { kind: 'missing' } },
      { read: found(), probe: readyProbe },
    ]);
    const tracker = new OpenCodeServiceStatusTracker(source);
    const seen: string[] = [];
    const unsubscribe = tracker.subscribe((snapshot) => seen.push(snapshot.state));

    await tracker.refresh();
    await tracker.refresh();
    await tracker.refresh();
    expect(seen).toEqual(['unregistered', 'ready']);

    unsubscribe();
    await tracker.refresh();
    expect(seen).toEqual(['unregistered', 'ready']);
  });

  it('concurrent refreshes share one probe cycle', async () => {
    const { source, cyclesRead } = scriptedSource([{ read: found(), probe: readyProbe }]);
    const tracker = new OpenCodeServiceStatusTracker(source);
    const [first, second] = await Promise.all([tracker.refresh(), tracker.refresh()]);
    expect(first).toBe(second);
    expect(cyclesRead()).toBe(1);
  });

  it('start() probes immediately and on cadence; stop() ends the cadence', async () => {
    vi.useFakeTimers();
    const { source, cyclesRead } = scriptedSource([{ read: found(), probe: readyProbe }]);
    const tracker = new OpenCodeServiceStatusTracker(source, { refreshIntervalMs: 30_000 });

    tracker.start();
    tracker.start(); // idempotent: no second timer
    await tracker.refresh(); // joins the in-flight first cycle
    expect(cyclesRead()).toBe(1);
    expect(tracker.getSnapshot().state).toBe('ready');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(cyclesRead()).toBe(2);

    tracker.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(cyclesRead()).toBe(2);
  });
});
