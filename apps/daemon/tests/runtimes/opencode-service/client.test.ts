import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  OpenCodeServiceClient,
  OpenCodeServiceError,
  parseRegistration,
  resolveRegistrationPath,
  sameServiceIdentity,
  type OpenCodeServiceRegistration,
} from '../../../src/runtimes/opencode-service/client.js';

const REGISTRATION: OpenCodeServiceRegistration = {
  id: 'svc-1',
  version: '2.2.5',
  url: 'http://127.0.0.1:49152',
  pid: 4242,
};

type CapturedCall = { url: string; init: RequestInit };

/** A fetch stub that records its call and answers with a fixed status/body. */
function fetchReturning(status: number, body: string) {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function fetchRejecting(error: unknown) {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

const infoBody = (version: string, pid: number) => JSON.stringify({ version, pid });

describe('resolveRegistrationPath', () => {
  it('prefers an explicit file over XDG resolution', () => {
    expect(
      resolveRegistrationPath({ file: '/tmp/custom/service.json', env: { XDG_STATE_HOME: '/xdg' } }),
    ).toBe('/tmp/custom/service.json');
  });

  it('resolves under $XDG_STATE_HOME/opencode/service.json', () => {
    expect(resolveRegistrationPath({ env: { XDG_STATE_HOME: '/xdg/state' } })).toBe(
      join('/xdg/state', 'opencode', 'service.json'),
    );
  });

  it('defaults to ~/.local/state/opencode/service.json', () => {
    expect(resolveRegistrationPath({ env: {} })).toBe(
      join(homedir(), '.local', 'state', 'opencode', 'service.json'),
    );
  });
});

describe('parseRegistration', () => {
  it('accepts a full registration', () => {
    expect(parseRegistration({ ...REGISTRATION, password: 'pw' })).toEqual({
      ...REGISTRATION,
      password: 'pw',
    });
  });

  it('accepts the minimal { url, pid } registration', () => {
    expect(parseRegistration({ url: 'http://127.0.0.1:1', pid: 1 })).toEqual({
      url: 'http://127.0.0.1:1',
      pid: 1,
    });
  });

  it.each([
    ['null', null],
    ['a string', 'service'],
    ['missing url', { pid: 1 }],
    ['empty url', { url: '', pid: 1 }],
    ['missing pid', { url: 'http://127.0.0.1:1' }],
    ['fractional pid', { url: 'http://127.0.0.1:1', pid: 1.5 }],
    ['negative pid', { url: 'http://127.0.0.1:1', pid: -1 }],
  ])('rejects %s', (_label, raw) => {
    expect(parseRegistration(raw)).toBeUndefined();
  });

  it('drops non-string optional fields instead of failing', () => {
    expect(parseRegistration({ url: 'http://127.0.0.1:1', pid: 7, password: 42, version: null })).toEqual({
      url: 'http://127.0.0.1:1',
      pid: 7,
    });
  });
});

describe('sameServiceIdentity', () => {
  it('compares id, version, url, and pid', () => {
    expect(sameServiceIdentity(REGISTRATION, { ...REGISTRATION })).toBe(true);
    expect(sameServiceIdentity(REGISTRATION, { ...REGISTRATION, pid: 9999 })).toBe(false);
    expect(sameServiceIdentity(REGISTRATION, { ...REGISTRATION, url: 'http://127.0.0.1:1' })).toBe(false);
  });

  it('ignores the password', () => {
    expect(sameServiceIdentity(REGISTRATION, { ...REGISTRATION, password: 'other' })).toBe(true);
  });
});

describe('OpenCodeServiceClient.readRegistration', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function clientFor(content: string | undefined) {
    dir = mkdtempSync(join(tmpdir(), 'odbun-p6-registration-'));
    const file = join(dir, 'service.json');
    if (content !== undefined) writeFileSync(file, content);
    return new OpenCodeServiceClient({ registrationFile: file });
  }

  it('reports a missing file without throwing', async () => {
    await expect(clientFor(undefined).readRegistration()).resolves.toEqual({ kind: 'missing' });
  });

  it('reports invalid JSON as malformed, without echoing file contents', async () => {
    const secret = 'pw-should-not-leak';
    const read = await clientFor(`{"url": "http://x", "password": "${secret}"`).readRegistration();
    expect(read.kind).toBe('malformed');
    if (read.kind === 'malformed') {
      expect(read.detail).toContain('not valid JSON');
      expect(read.detail).not.toContain(secret);
    }
  });

  it('reports missing fields as malformed, naming the field', async () => {
    const read = await clientFor(JSON.stringify({ url: 'http://127.0.0.1:1' })).readRegistration();
    expect(read.kind).toBe('malformed');
    if (read.kind === 'malformed') expect(read.detail).toContain('pid');
  });

  it('returns the parsed registration', async () => {
    const read = await clientFor(JSON.stringify({ ...REGISTRATION, password: 'pw' })).readRegistration();
    expect(read).toEqual({ kind: 'found', registration: { ...REGISTRATION, password: 'pw' } });
  });
});

describe('OpenCodeServiceClient.probe — §4.1 classification', () => {
  const probeWith = (fetchImpl: typeof fetch, registration: OpenCodeServiceRegistration = REGISTRATION) =>
    new OpenCodeServiceClient({ fetchImpl }).probe(registration);

  it('unreachable: fetch rejects with a transport error', async () => {
    const result = await probeWith(fetchRejecting(new TypeError('fetch failed')));
    expect(result.classification).toBe('unreachable');
    expect(result.httpStatus).toBeUndefined();
  });

  it('unreachable: fetch rejects with a timeout error', async () => {
    const result = await probeWith(
      fetchRejecting(new DOMException('The operation timed out', 'TimeoutError')),
    );
    expect(result.classification).toBe('unreachable');
  });

  it('incompatible: /api/info answers 404', async () => {
    const { fetchImpl } = fetchReturning(404, 'not found');
    const result = await probeWith(fetchImpl);
    expect(result.classification).toBe('incompatible');
    expect(result.httpStatus).toBe(404);
  });

  it('incompatible: body is not JSON', async () => {
    const { fetchImpl } = fetchReturning(200, '<html>proxy error</html>');
    expect((await probeWith(fetchImpl)).classification).toBe('incompatible');
  });

  it('incompatible: body does not decode to { version: string, pid: integer }', async () => {
    const { fetchImpl } = fetchReturning(200, JSON.stringify({ version: 2, pid: '4242' }));
    expect((await probeWith(fetchImpl)).classification).toBe('incompatible');
  });

  it('incompatible: pid mismatch against the registration', async () => {
    const { fetchImpl } = fetchReturning(200, infoBody('2.2.5', 9999));
    const result = await probeWith(fetchImpl);
    expect(result.classification).toBe('incompatible');
    expect(result.reason).toContain('pid');
  });

  it('incompatible: service version differs from the registration (stale registration)', async () => {
    const { fetchImpl } = fetchReturning(200, infoBody('2.3.0', REGISTRATION.pid));
    const result = await probeWith(fetchImpl);
    expect(result.classification).toBe('incompatible');
    expect(result.serverVersion).toBe('2.3.0');
  });

  it('failed: HTTP 500 with a consistent info body', async () => {
    const { fetchImpl } = fetchReturning(500, infoBody('2.2.5', REGISTRATION.pid));
    const result = await probeWith(fetchImpl);
    expect(result.classification).toBe('failed');
    expect(result.httpStatus).toBe(500);
  });

  it('waiting: any other status with a consistent info body', async () => {
    const { fetchImpl } = fetchReturning(503, infoBody('2.2.5', REGISTRATION.pid));
    const result = await probeWith(fetchImpl);
    expect(result.classification).toBe('waiting');
    expect(result.httpStatus).toBe(503);
  });

  it('ready: HTTP 200 with matching version and pid', async () => {
    const { fetchImpl } = fetchReturning(200, infoBody('2.2.5', REGISTRATION.pid));
    const result = await probeWith(fetchImpl);
    expect(result.classification).toBe('ready');
    expect(result.serverVersion).toBe('2.2.5');
  });

  it('ready: a registration without a version accepts any service version', async () => {
    const { fetchImpl } = fetchReturning(200, infoBody('9.9.9', REGISTRATION.pid));
    const { version: _version, ...withoutVersion } = REGISTRATION;
    const result = await probeWith(fetchImpl, withoutVersion);
    expect(result.classification).toBe('ready');
    expect(result.serverVersion).toBe('9.9.9');
  });
});

describe('OpenCodeServiceClient.probe — auth', () => {
  it('sends HTTP Basic auth when a password is registered', async () => {
    const { calls, fetchImpl } = fetchReturning(200, infoBody('2.2.5', REGISTRATION.pid));
    await new OpenCodeServiceClient({ fetchImpl }).probe({ ...REGISTRATION, password: 'pw-test' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${REGISTRATION.url}/api/info`);
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe(
      'Basic ' + Buffer.from('opencode:pw-test').toString('base64'),
    );
  });

  it('sends no auth header when no password is registered', async () => {
    const { calls, fetchImpl } = fetchReturning(200, infoBody('2.2.5', REGISTRATION.pid));
    await new OpenCodeServiceClient({ fetchImpl }).probe(REGISTRATION);
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wrappers against a shape-faithful stub service (node:http, so the suite
// runs identically on the Bun and Node harnesses). The stub records every
// request verbatim and answers with the v2 envelope shapes the spike
// proved against the real binary.
// ---------------------------------------------------------------------------

type RecordedRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

const STUB_PASSWORD = 'pw-stub-secret';

describe('OpenCodeServiceConnection wrappers (stub service)', () => {
  let server: Server;
  let baseUrl: string;
  const recorded: RecordedRequest[] = [];

  const session = {
    id: 'ses_1',
    title: 'stub session',
    model: { providerID: 'opencode', id: 'deepseek-v4-flash-free' },
    location: { directory: '/tmp/project' },
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        recorded.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const json = (status: number, value: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(value));
        };
        const route = `${req.method} ${req.url}`;
        if (route === 'GET /api/info') return json(200, { version: '2.2.5', pid: 4242 });
        if (route === 'GET /api/provider') {
          return json(200, { location: { directory: '/' }, data: [{ id: 'opencode', name: 'OpenCode' }] });
        }
        if (route === 'GET /api/model') {
          return json(200, {
            location: { directory: '/' },
            data: [
              {
                id: 'opencode/deepseek-v4-flash-free',
                modelID: 'deepseek-v4-flash-free',
                providerID: 'opencode',
                name: 'DeepSeek V4 Flash Free',
                variants: [{ id: 'low' }, { id: 'high' }],
              },
            ],
          });
        }
        if (route === 'POST /api/session') return json(200, { data: session });
        if (route === 'GET /api/session') return json(200, { data: [session], cursor: {} });
        if (route === 'GET /api/session/ses_1') return json(200, { data: session });
        if (route === 'POST /api/session/ses_1/prompt') {
          const admitted = JSON.parse(recorded[recorded.length - 1]?.body ?? '{}') as {
            text?: string;
            delivery?: string;
          };
          return json(200, {
            data: {
              id: 'msg_1',
              type: 'user',
              delivery: admitted.delivery ?? 'steer',
              payload: { text: admitted.text ?? '' },
            },
          });
        }
        if (route === 'GET /api/session/ses_1/message') {
          return json(200, {
            data: [
              { id: 'm1', type: 'user', content: [{ type: 'text', text: 'hi' }] },
              { id: 'm2', type: 'assistant', content: [{ type: 'text', text: 'hello' }] },
            ],
            cursor: {},
          });
        }
        if (route === 'GET /api/event') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('data: {"type":"server.connected"}\n\n');
          return;
        }
        if (route === 'GET /api/forbidden') {
          // Deliberately echoes the credential in the body: error surfaces
          // must still never contain it.
          res.writeHead(401, { 'content-type': 'text/plain' });
          res.end(`unauthorized for ${STUB_PASSWORD}`);
          return;
        }
        return json(404, { error: 'unknown route' });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('stub server has no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connection(password?: string) {
    const client = new OpenCodeServiceClient();
    return client.connect({
      id: 'svc-stub',
      version: '2.2.5',
      url: baseUrl,
      pid: 4242,
      ...(password === undefined ? {} : { password }),
    });
  }

  function lastRequest(method: string, url: string): RecordedRequest {
    const found = [...recorded].reverse().find((r) => r.method === method && r.url === url);
    if (found === undefined) throw new Error(`no recorded request ${method} ${url}`);
    return found;
  }

  it('info() decodes the raw (unenveloped) /api/info body', async () => {
    await expect(connection().info()).resolves.toEqual({ version: '2.2.5', pid: 4242 });
  });

  it('listProviders() unwraps the { location, data } envelope', async () => {
    await expect(connection().listProviders()).resolves.toEqual([{ id: 'opencode', name: 'OpenCode' }]);
  });

  it('listModels() returns catalog entries with Model.Info.id semantics', async () => {
    await expect(connection().listModels()).resolves.toEqual([
      {
        id: 'opencode/deepseek-v4-flash-free',
        modelID: 'deepseek-v4-flash-free',
        providerID: 'opencode',
        name: 'DeepSeek V4 Flash Free',
        variants: [{ id: 'low' }, { id: 'high' }],
      },
    ]);
  });

  it('createSession() posts the spike-proven body: title, model { providerID, id, variant }, location { directory }', async () => {
    const created = await connection().createSession({
      title: 'design run',
      model: { providerID: 'opencode', id: 'opencode/deepseek-v4-flash-free', variant: 'low' },
      location: { directory: '/tmp/project' },
      metadata: { 'odbun.conversationId': 'conv-1' },
    });
    expect(created.id).toBe('ses_1');
    const request = lastRequest('POST', '/api/session');
    expect(JSON.parse(request.body)).toEqual({
      title: 'design run',
      model: { providerID: 'opencode', id: 'opencode/deepseek-v4-flash-free', variant: 'low' },
      location: { directory: '/tmp/project' },
      metadata: { 'odbun.conversationId': 'conv-1' },
    });
    expect(request.headers['content-type']).toBe('application/json');
  });

  it('createSession() omits undefined optional fields entirely', async () => {
    await connection().createSession({ location: { directory: '/tmp/project' } });
    const request = lastRequest('POST', '/api/session');
    expect(JSON.parse(request.body)).toEqual({ location: { directory: '/tmp/project' } });
  });

  it('getSession() and listSessions() read sessions back', async () => {
    await expect(connection().getSession('ses_1')).resolves.toMatchObject({ id: 'ses_1' });
    await expect(connection().listSessions()).resolves.toMatchObject([{ id: 'ses_1' }]);
  });

  it('prompt() posts { text } by default and returns the admitted inbox item', async () => {
    const admitted = await connection().prompt('ses_1', { text: 'draw a poster' });
    expect(JSON.parse(lastRequest('POST', '/api/session/ses_1/prompt').body)).toEqual({
      text: 'draw a poster',
    });
    expect(admitted).toEqual({
      id: 'msg_1',
      type: 'user',
      delivery: 'steer',
      payload: { text: 'draw a poster' },
    });
  });

  it('prompt() passes delivery through for steering and queueing', async () => {
    const admitted = await connection().prompt('ses_1', { text: 'queued note', delivery: 'queue' });
    expect(JSON.parse(lastRequest('POST', '/api/session/ses_1/prompt').body)).toEqual({
      text: 'queued note',
      delivery: 'queue',
    });
    expect(admitted.delivery).toBe('queue');
  });

  it('listMessages() returns projected messages with text content', async () => {
    const messages = await connection().listMessages('ses_1');
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      type: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    });
  });

  it('openEventStream() returns the live SSE response', async () => {
    const response = await connection().openEventStream();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('server.connected');
  });

  it('sends the Basic auth header on wrapper calls when a password is registered', async () => {
    await connection(STUB_PASSWORD).info();
    const request = lastRequest('GET', '/api/info');
    expect(request.headers.authorization).toBe(
      'Basic ' + Buffer.from(`opencode:${STUB_PASSWORD}`).toString('base64'),
    );
  });

  it('sends no auth header on wrapper calls without a password', async () => {
    await connection().info();
    expect(lastRequest('GET', '/api/info').headers.authorization).toBeUndefined();
  });

  it('surfaced errors never contain the registered password', async () => {
    const failing = connection(STUB_PASSWORD);
    const error = await failing.requestJson('GET', '/api/forbidden').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenCodeServiceError);
    const serviceError = error as OpenCodeServiceError;
    expect(serviceError.kind).toBe('http');
    expect(serviceError.status).toBe(401);
    expect(serviceError.message).not.toContain(STUB_PASSWORD);
    expect(JSON.stringify(serviceError)).not.toContain(STUB_PASSWORD);
    expect(String(serviceError.stack)).not.toContain(STUB_PASSWORD);
  });

  it('raises a typed http error for unknown sessions', async () => {
    const error = await connection()
      .getSession('ses_missing')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenCodeServiceError);
    expect((error as OpenCodeServiceError).status).toBe(404);
  });

  it('connection.target never exposes the password', () => {
    const bound = connection(STUB_PASSWORD);
    expect(bound.target).toEqual({ id: 'svc-stub', version: '2.2.5', url: baseUrl, pid: 4242 });
    expect(JSON.stringify(bound.target)).not.toContain(STUB_PASSWORD);
  });
});
