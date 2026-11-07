import { describe, expect, it, vi } from 'vitest';

import {
  extractOpenCodeServerBaseUrl,
  fetchOpenCodeModelInfoWithRetry,
} from '../../src/runtimes/defs/opencode.js';

// The one-shot `opencode serve --stdio` announcement changed shape across
// v2 builds: v2.2.6 prints a JSON line, older builds printed the bare URL.
// The old probe scanned stdout with /https?:\/\/[^\s]+/, which swallowed
// the JSON line's closing `"}` into the URL — an invalid port, a throwing
// fetch, and a silently empty variant catalog (live daemon: 553 opencode
// models, 0 with reasoningOptions). These tests lock the real line shapes.
describe('extractOpenCodeServerBaseUrl', () => {
  it('reads the v2.2.6 JSON announcement line', () => {
    expect(extractOpenCodeServerBaseUrl('{"url":"http://127.0.0.1:35933"}')).toBe(
      'http://127.0.0.1:35933',
    );
    expect(extractOpenCodeServerBaseUrl('{"url":"http://127.0.0.1:35933"}\n')).toBe(
      'http://127.0.0.1:35933',
    );
  });

  it('reads a bare URL line (older builds)', () => {
    expect(extractOpenCodeServerBaseUrl('http://127.0.0.1:35933')).toBe(
      'http://127.0.0.1:35933',
    );
    expect(extractOpenCodeServerBaseUrl('http://127.0.0.1:35933/')).toBe(
      'http://127.0.0.1:35933',
    );
  });

  it('reads a URL embedded in surrounding log text', () => {
    expect(
      extractOpenCodeServerBaseUrl('opencode server listening at http://127.0.0.1:35933 (ready)'),
    ).toBe('http://127.0.0.1:35933');
    expect(
      extractOpenCodeServerBaseUrl('INFO service=server url=http://127.0.0.1:35933 started'),
    ).toBe('http://127.0.0.1:35933');
  });

  it('never lets a trailing "} leak into the URL', () => {
    // Unterminated JSON (stdout chunk boundary): the JSON parse fails and
    // the text scan must still stop before the closing quote/brace.
    const fromPartialJson = extractOpenCodeServerBaseUrl('{"url":"http://127.0.0.1:35933"');
    expect(fromPartialJson).toBe('http://127.0.0.1:35933');
    expect(fromPartialJson).not.toContain('"');
    expect(fromPartialJson).not.toContain('}');
    const fromQuoted = extractOpenCodeServerBaseUrl('announcing "http://127.0.0.1:35933"} done');
    expect(fromQuoted).toBe('http://127.0.0.1:35933');
  });

  it('finds the announcement after earlier log lines', () => {
    const text = [
      'loading plugins...',
      '{"url":"http://127.0.0.1:35933"}',
      'ready',
    ].join('\n');
    expect(extractOpenCodeServerBaseUrl(text)).toBe('http://127.0.0.1:35933');
  });

  it('returns null when there is no usable http(s) URL', () => {
    expect(extractOpenCodeServerBaseUrl('')).toBeNull();
    expect(extractOpenCodeServerBaseUrl('no url here')).toBeNull();
    expect(extractOpenCodeServerBaseUrl('{"url":"ftp://127.0.0.1:21"}')).toBeNull();
    expect(extractOpenCodeServerBaseUrl('{"other":true}')).toBeNull();
  });
});

// The one-shot server prints its URL line before its listener accepts
// connections (measured ~1 s), so the probe retries connection-level
// failures inside its budget instead of fetching exactly once.
describe('fetchOpenCodeModelInfoWithRetry', () => {
  const payload = [
    {
      id: 'muse-spark-1.3-contributor',
      providerID: 'meta',
      variants: [{ id: 'low' }, { id: 'xhigh' }],
    },
    { id: 'plain-model', providerID: 'meta', variants: [] },
  ];

  it('returns the parsed catalog after a connection-refused first attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed: connect ECONNREFUSED'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: payload }), { status: 200 }),
      ) as unknown as typeof fetch;
    const models = await fetchOpenCodeModelInfoWithRetry({
      baseUrl: 'http://127.0.0.1:35933',
      password: 'probe-pass',
      deadline: Date.now() + 5_000,
      fetchImpl,
      retryDelayMs: 5,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const target = models?.find((model) => model.id === 'meta/muse-spark-1.3-contributor');
    expect(target?.reasoningOptions).toEqual([
      { id: 'default', label: 'Default' },
      { id: 'low', label: 'low' },
      { id: 'xhigh', label: 'xhigh' },
    ]);
    const plain = models?.find((model) => model.id === 'meta/plain-model');
    expect(plain?.reasoningOptions).toBeUndefined();
  });

  it('resolves null when the connection never comes up inside the budget', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError('fetch failed: connect ECONNREFUSED')) as unknown as typeof fetch;
    const models = await fetchOpenCodeModelInfoWithRetry({
      baseUrl: 'http://127.0.0.1:35933',
      password: 'probe-pass',
      deadline: Date.now() + 150,
      fetchImpl,
      retryDelayMs: 10,
    });
    expect(models).toBeNull();
    expect(vi.mocked(fetchImpl).mock.calls.length).toBeGreaterThan(1);
  });

  it('does not retry a completed non-2xx response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const models = await fetchOpenCodeModelInfoWithRetry({
      baseUrl: 'http://127.0.0.1:35933',
      password: 'probe-pass',
      deadline: Date.now() + 5_000,
      fetchImpl,
      retryDelayMs: 5,
    });
    expect(models).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
