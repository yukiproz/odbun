// Proxy resolution for connection-test / provider fetches, R4 contract.
//
// These tests originally asserted the pre-port Undici dispatcher
// contract: `proxyDispatcherRequestInit()` returning a requestInit
// whose `dispatcher` was an EnvHttpProxyAgent / Socks5ProxyAgent (or a
// per-scheme routing wrapper) and per-request dispatch() routing.
// R4 dropped Undici (see port/TEST-SUITES.md §4.4): Bun's native fetch
// takes a single `proxy` URL string per request, so the helper now
// resolves the proxy env into ONE proxy string on the request init,
// `close` is a no-op, and NO_PROXY bypass is expressed by dropping the
// proxy when the caller supplies the target URL. The tests below
// assert that contract with the same proxy-env semantics the
// dispatcher-era tests protected (HTTP/HTTPS selection, SOCKS
// fallback, socks5h normalization, NO_PROXY exclusions). The
// per-request dispatch-routing assertions have no counterpart in a
// single-string contract and were dropped (§4.4 / §7 of the record).

import { afterEach, describe, expect, it, vi } from 'vitest';

const { resolveSystemProxyEnvMock } = vi.hoisted(() => ({
  resolveSystemProxyEnvMock: vi.fn(() => ({})),
}));

vi.mock('@open-design/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@open-design/platform')>()),
  resolveSystemProxyEnv: resolveSystemProxyEnvMock,
}));

import { proxyDispatcherRequestInit } from '../src/connectionTest.js';

describe('proxyDispatcherRequestInit', () => {
  afterEach(() => {
    resolveSystemProxyEnvMock.mockReset();
    resolveSystemProxyEnvMock.mockReturnValue({});
  });

  it('returns the HTTP proxy as a native fetch proxy string (timeout options accepted for call-shape compatibility)', async () => {
    // The old Undici dispatchers consumed headers/body timeouts at
    // construction; native fetch has no equivalent (callers'
    // AbortSignals govern timeouts), so R4 accepts the options only
    // to keep the call shape — the resolved proxy must come back as a
    // plain string and no dispatcher may appear on the init.
    const { close, requestInit } = proxyDispatcherRequestInit(
      {
        HTTP_PROXY: 'http://proxy.example.test:8080',
      },
      {
        headersTimeout: 10 * 60 * 1000,
        bodyTimeout: 10 * 60 * 1000,
      },
    );

    expect(requestInit).toEqual({ proxy: 'http://proxy.example.test:8080' });
    expect('dispatcher' in requestInit).toBe(false);
    await expect(close()).resolves.toBeUndefined();
  });

  it('uses the SOCKS proxy string when only ALL_PROXY carries a SOCKS proxy', async () => {
    const { close, requestInit } = proxyDispatcherRequestInit({
      ALL_PROXY: 'socks5://proxy.example.test:1080',
    });

    // Bun-native fetch speaks socks5:// directly.
    expect(requestInit).toEqual({ proxy: 'socks5://proxy.example.test:1080' });
    await expect(close()).resolves.toBeUndefined();
  });

  it('normalizes socks5h ALL_PROXY values to socks5', async () => {
    const { close, requestInit } = proxyDispatcherRequestInit({
      ALL_PROXY: 'socks5h://proxy.example.test:1080',
    });

    expect(requestInit).toEqual({ proxy: 'socks5://proxy.example.test:1080' });
    await expect(close()).resolves.toBeUndefined();
  });

  it('accepts timeout options alongside a SOCKS proxy (call-shape compatibility)', async () => {
    const { close, requestInit } = proxyDispatcherRequestInit(
      {
        ALL_PROXY: 'socks5://proxy.example.test:1080',
      },
      {
        headersTimeout: 10 * 60 * 1000,
        bodyTimeout: 10 * 60 * 1000,
      },
    );

    expect(requestInit).toEqual({ proxy: 'socks5://proxy.example.test:1080' });
    await expect(close()).resolves.toBeUndefined();
  });

  // The dispatcher stack additionally routed the scheme WITHOUT a
  // specific proxy to the SOCKS agent per request. A single proxy
  // string cannot express per-scheme routing: the configured HTTP(S)
  // proxy wins outright and the SOCKS ALL_PROXY is only the fallback
  // when no HTTP(S) proxy exists (covered by the tests above). The
  // dispatch-routing half of the original cases is dropped — see
  // port/TEST-SUITES.md §4.4 / §7.
  it.each([
    {
      label: 'HTTP_PROXY',
      env: {
        ALL_PROXY: 'socks5://system-socks.example.test:1080',
        HTTP_PROXY: 'http://system-http.example.test:8080',
      },
      expectedProxy: 'http://system-http.example.test:8080',
    },
    {
      label: 'HTTPS_PROXY',
      env: {
        ALL_PROXY: 'socks5://system-socks.example.test:1080',
        HTTPS_PROXY: 'http://system-https.example.test:8443',
      },
      expectedProxy: 'http://system-https.example.test:8443',
    },
  ])('prefers the configured $label proxy over the SOCKS ALL_PROXY fallback', async ({
    env,
    expectedProxy,
  }) => {
    const { close, requestInit } = proxyDispatcherRequestInit(env);

    expect(requestInit).toEqual({ proxy: expectedProxy });
    await expect(close()).resolves.toBeUndefined();
  });

  it('drops the proxy for loopback targets covered by the NO_PROXY defaults', async () => {
    const { close, requestInit } = proxyDispatcherRequestInit(
      {
        ALL_PROXY: 'socks5://proxy.example.test:1080',
      },
      {},
      'http://localhost:11434/v1/chat/completions',
    );

    expect(requestInit).toEqual({});
    await expect(close()).resolves.toBeUndefined();
  });

  it('drops the proxy for explicit NO_PROXY hosts', async () => {
    const { close, requestInit } = proxyDispatcherRequestInit(
      {
        ALL_PROXY: 'socks5://proxy.example.test:1080',
        NO_PROXY: '.corp.test',
      },
      {},
      'https://api.corp.test/v1/models',
    );

    expect(requestInit).toEqual({});
    await expect(close()).resolves.toBeUndefined();
  });

  it('keeps the proxy for hosts outside NO_PROXY', async () => {
    const { close, requestInit } = proxyDispatcherRequestInit(
      {
        ALL_PROXY: 'socks5://proxy.example.test:1080',
        NO_PROXY: '.corp.test',
      },
      {},
      'https://api.openai.com/v1/chat/completions',
    );

    expect(requestInit).toEqual({ proxy: 'socks5://proxy.example.test:1080' });
    await expect(close()).resolves.toBeUndefined();
  });

  it('drops the proxy for simple hosts when NO_PROXY includes <local>', async () => {
    const { close, requestInit } = proxyDispatcherRequestInit(
      {
        HTTP_PROXY: 'http://proxy.example.test:8080',
        NO_PROXY: '<local>,localhost,127.0.0.1,[::1],.local',
      },
      {},
      'http://ollama:11434/api/tags',
    );

    expect(requestInit).toEqual({});
    await expect(close()).resolves.toBeUndefined();
  });

  it('returns no proxy field when no proxy env is configured', async () => {
    const { close, requestInit } = proxyDispatcherRequestInit({});

    expect(resolveSystemProxyEnvMock).toHaveBeenCalledWith();
    expect(requestInit).toEqual({});
    expect('proxy' in requestInit).toBe(false);
    await expect(close()).resolves.toBeUndefined();
  });
});
