import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { runInNewContext } from 'node:vm';

import type { RouteHandlerArgs } from 'eve/channels';
import { type AuthFn, none, oauthResource } from 'eve/channels/auth';
import { z } from 'zod';

import { type McpServerChannelOptions, mcpServerChannel } from './channel.js';
import { defineMcpTool } from './tool.js';

const SECRET = 'PRIVATE_DETAIL';
const META = {
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
};
// Only `requestIp` is read on this path; the rest belongs to eve's runtime.
const CHANNEL = {
  params: {},
  requestIp: '203.0.113.9',
} as unknown as RouteHandlerArgs;

const DEPLOYMENT_KEYS = ['EVE_DEV', 'VERCEL', 'VERCEL_ENV'] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of DEPLOYMENT_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of DEPLOYMENT_KEYS) {
    const value = savedEnv.get(key);

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

let calls = 0;

const whoami = defineMcpTool({
  async call(_input, { auth }, { requestIp }) {
    calls++;
    const principal = {
      principalId: auth.principalId,
      requestIp,
      team: auth.attributes.team ?? null,
    };

    return {
      content: [{ text: JSON.stringify(principal), type: 'text' }],
      structuredContent: principal,
    };
  },
  definition: {
    inputSchema: z.object({}),
    name: 'whoami',
    outputSchema: z.object({
      principalId: z.string(),
      requestIp: z.string().nullable(),
      team: z.unknown(),
    }),
  },
});

const vandal = defineMcpTool({
  async call(_input, { auth }) {
    try {
      (auth.attributes as Record<string, unknown>).team =
        'written by another caller';
    } catch {
      // A frozen principal refuses the write; the test checks the next caller.
    }

    return { content: [] };
  },
  definition: { inputSchema: z.object({}), name: 'vandal' },
});

const failing = defineMcpTool({
  async call() {
    throw new Error(SECRET);
  },
  definition: { inputSchema: z.object({}), name: 'failing' },
});

const refining = defineMcpTool({
  async call() {
    return { content: [], structuredContent: { ok: true } };
  },
  definition: {
    inputSchema: z.object({
      value: z.string().refine(() => {
        throw new Error(SECRET);
      }),
    }),
    name: 'refining',
    outputSchema: z.object({
      ok: z.boolean().refine(() => {
        throw new Error(SECRET);
      }),
    }),
  },
});

let running = 0;
let peak = 0;

const slow = defineMcpTool({
  async call() {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running--;

    return { content: [] };
  },
  definition: { inputSchema: z.object({}), name: 'slow' },
});

function channel(overrides: Partial<McpServerChannelOptions> = {}) {
  return mcpServerChannel({
    allowedHosts: ['127.0.0.1'],
    auth: none(),
    // A self-hosted setup must say how it knows about HTTPS; these tests are local.
    https: 'off',
    name: 'test',
    onToolError: () => undefined,
    route: '/mcp',
    tools: [whoami, vandal, failing, refining, slow],
    version: '0.0.0',
    ...overrides,
  });
}

type Target = ReturnType<typeof channel>;

async function send(
  target: Target,
  init: {
    body?: unknown;
    headers?: Record<string, string>;
    method?: string;
    path?: string;
    requestIp?: string;
    url?: string;
  },
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const method = init.method ?? 'POST';
  const path = init.path ?? '/mcp';
  const route = target.routes.find(
    (r) => r.method === method && r.path === path,
  );

  assert.ok(route && route.transport !== 'websocket', `${method} ${path}`);
  const response = await route.handler(
    new Request(init.url ?? `http://127.0.0.1${path}`, {
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        host: new URL(init.url ?? `http://127.0.0.1${path}`).host,
        ...init.headers,
      },
      method,
    }),
    init.requestIp === undefined
      ? CHANNEL
      : ({ ...CHANNEL, requestIp: init.requestIp } as RouteHandlerArgs),
  );
  const text = await response.text();
  const events = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)));
  const body =
    events.length > 1
      ? events
      : (events[0] ?? (text ? JSON.parse(text) : null));

  return { body, headers: response.headers, status: response.status };
}

function modern(method: string, params: Record<string, unknown> = {}) {
  return {
    body: { id: 1, jsonrpc: '2.0', method, params: { ...params, _meta: META } },
    headers: {
      'mcp-method': method,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
    },
  };
}

function legacy(method: string, params: Record<string, unknown> = {}) {
  return {
    body: { id: 1, jsonrpc: '2.0', method, params },
    headers: { 'mcp-protocol-version': '2025-11-25' },
  };
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return modern('tools/call', { arguments: args, name });
}

interface Result {
  result: { structuredContent: Record<string, unknown>; isError?: boolean };
}

describe('options', () => {
  test('requires auth, a route and something to serve', () => {
    assert.throws(
      () => channel({ auth: undefined as unknown as AuthFn<Request> }),
      /requires auth/,
    );
    assert.throws(() => channel({ route: 'mcp' }), /route/);
    assert.throws(() => channel({ tools: [] }), /tools, register/);
    assert.throws(() => channel({ tools: [whoami, whoami] }), /unique/);
  });

  // Blocker 8: NaN and Infinity turned the limit off.
  test('refuses limits that would switch a bound off', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      assert.throws(() => channel({ maxBodyBytes: bad }), /maxBodyBytes/);
      assert.throws(() => channel({ bodyTimeoutMs: bad }), /bodyTimeoutMs/);
      assert.throws(
        () => channel({ allowBatches: { maxMessages: bad } }),
        /maxMessages/,
      );
      assert.throws(
        () => channel({ allowBatches: { concurrency: bad } }),
        /concurrency/,
      );
    }
  });

  // C6: `allowBatches: 'false'` switched batches on.
  test('takes only a boolean or a plain object for allowBatches', () => {
    const loose = (value: unknown) => value as never;

    for (const bad of ['false', 1, [], null, new Date(0)]) {
      assert.throws(
        () => channel({ allowBatches: loose(bad) }),
        /allowBatches/,
        String(bad),
      );
    }
    assert.ok(channel({ allowBatches: { maxMessages: 2 } }));
  });

  // C6: a misspelt bound was ignored, leaving the default in force.
  test('refuses keys allowBatches does not know', () => {
    assert.throws(
      () => channel({ allowBatches: { maxMesages: 2 } as never }),
      /maxMesages/,
    );
  });

  // R4.
  test('takes allowedOrigins only as origins a browser would send', () => {
    for (const bad of [
      'https://app.example/',
      'https://app.example/path',
      'https://app.example?x=1',
      'https://app.example#f',
      'https://App.example',
      'https://app.example:443',
      'app.example',
      'ftp://app.example',
      'null',
    ]) {
      assert.throws(
        () => channel({ allowedOrigins: [bad] }),
        /allowedOrigins/,
        bad,
      );
    }
    assert.throws(() => channel({ allowedOrigins: [] }), /allowedOrigins/);
    assert.ok(
      channel({
        allowedOrigins: ['http://localhost:3000', 'https://app.example:8443'],
      }),
    );
  });

  test('refuses settings it does not know', () => {
    const loose = (value: unknown) => value as never;

    assert.throws(() => channel({ legacy: loose('lenient') }), /legacy/);
    assert.throws(
      () => channel({ responseMode: loose('stream') }),
      /responseMode/,
    );
    assert.throws(() => channel({ https: loose('yes') }), /https/);
    assert.throws(
      () => channel({ allowedHosts: ['https://app.example'] }),
      /bare hostname/,
    );
    assert.throws(() => channel({ allowedHosts: [] }), /allowedHosts/);
    assert.throws(() => channel({ onToolError: loose('log') }), /onToolError/);
  });

  // Item 12: an oauthResource() policy used to publish discovery through an internal reader.
  test('asks for the oauth option when auth is wrapped in oauthResource()', () => {
    const wrapped = oauthResource(none(), { issuer: 'https://auth.example' });

    assert.throws(() => channel({ auth: wrapped }), /oauth option/);
    assert.throws(() => channel({ auth: [wrapped] }), /oauth option/);
  });

  test('answers POST, GET and DELETE at the route, and the metadata where told', () => {
    const paths = channel({
      oauth: {
        issuer: 'https://auth.example',
        metadataPath: '/eve/v1/oauth-protected-resource/mcp',
        resource: 'https://app.example/eve/v1/mcp',
      },
    }).routes.map((r) => `${r.method} ${r.path}`);

    assert.deepEqual(paths, [
      'GET /eve/v1/oauth-protected-resource/mcp',
      'HEAD /eve/v1/oauth-protected-resource/mcp',
      'OPTIONS /eve/v1/oauth-protected-resource/mcp',
      'POST /mcp',
      'GET /mcp',
      'DELETE /mcp',
    ]);
  });
});

describe('serving', () => {
  test('hands a tool its principal and address in the 2026 era', async () => {
    const { body, status } = await send(channel(), toolCall('whoami'));

    assert.equal(status, 200);
    assert.deepEqual((body as Result).result.structuredContent, {
      principalId: 'anonymous',
      requestIp: '203.0.113.9',
      team: null,
    });
  });

  test('hands a tool its principal in the 2025 era', async () => {
    const { body } = await send(
      channel(),
      legacy('tools/call', { arguments: {}, name: 'whoami' }),
    );

    assert.equal(
      (body as Result).result.structuredContent.principalId,
      'anonymous',
    );
  });

  test('does not advertise tool-list changes it could never send', async () => {
    const { body } = await send(channel(), modern('server/discover'));

    assert.deepEqual(
      (body as { result: { capabilities: unknown } }).result.capabilities,
      { tools: { listChanged: false } },
    );
  });

  test('answers GET with 405, as a stateless server', async () => {
    assert.equal((await send(channel(), { method: 'GET' })).status, 405);
  });

  test('gives register the SDK server, the era and addTool', async () => {
    const eras: string[] = [];
    const target = channel({
      register(server, { addTool, era }) {
        eras.push(era);
        server.registerTool(
          'extra',
          { inputSchema: z.object({}) },
          async () => ({
            content: [{ text: era, type: 'text' }],
          }),
        );
        addTool(
          defineMcpTool({
            async call() {
              throw new Error(SECRET);
            },
            definition: { inputSchema: z.object({}), name: 'added' },
          }),
        );
      },
    });
    const listed = await send(target, modern('tools/list'));
    const names = (
      listed.body as { result: { tools: { name: string }[] } }
    ).result.tools.map((t) => t.name);
    // Blocker 6c: a tool added in register gets the same error handling as `tools`.
    const added = await send(target, toolCall('added'));

    await send(target, legacy('tools/list'));
    assert.deepEqual(names.slice(-2), ['extra', 'added']);
    assert.deepEqual(eras, ['modern', 'modern', 'legacy']);
    assert.equal(JSON.stringify(added.body).includes(SECRET), false);
  });
});

describe('admission', () => {
  // Blocker 2: under eve dev only loopback hosts get in, on every route.
  test('refuses a rebinding request, on the endpoint and the metadata', async () => {
    process.env.EVE_DEV = '1';
    // No allowedHosts: the eve dev default is what is under test.
    const target = mcpServerChannel({
      auth: none(),
      name: 'test',
      oauth: {
        issuer: 'https://auth.example',
        resource: 'https://app.example/mcp',
      },
      route: '/mcp',
      tools: [whoami],
      version: '0.0.0',
    });
    const rebound = {
      host: 'attacker.example:3104',
      origin: 'http://attacker.example:3104',
    };
    const before = calls;

    for (const path of ['/mcp', '/.well-known/oauth-protected-resource/mcp']) {
      const { status } = await send(target, {
        ...toolCall('whoami'),
        headers: { ...toolCall('whoami').headers, ...rebound },
        method: path === '/mcp' ? 'POST' : 'GET',
        path,
        url: `http://attacker.example:3104${path}`,
      });

      assert.equal(status, 403, path);
    }
    assert.equal(calls, before);
  });

  // Blocker 3.
  test('on Vercel refuses plain HTTP, whatever X-Forwarded-Proto says', async () => {
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'production';
    const before = calls;
    const { status } = await send(channel({ https: 'auto' }), {
      ...toolCall('whoami'),
      headers: { ...toolCall('whoami').headers, 'x-forwarded-proto': 'https' },
      url: 'http://127.0.0.1/mcp',
    });

    assert.equal(status, 403);
    assert.equal(calls, before);
  });

  // N6, L5 and C2: a misconfigured deployment is reported at most once a
  // minute, and a reporter that throws or rejects neither reaches the client
  // nor becomes an unhandled rejection.
  test('reports a misconfigured deployment once a minute, safely', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    const reported: string[] = [];

    process.on('unhandledRejection', onUnhandled);
    try {
      for (const onError of [
        (error: Error) => {
          reported.push(error.message);
          throw new Error(SECRET);
        },
        async (error: Error) => {
          reported.push(error.message);
          throw new Error(SECRET);
        },
      ]) {
        const target = channel({ https: 'auto', onError });

        for (const _ of [1, 2, 3]) {
          const { body, status } = await send(target, toolCall('whoami'));

          assert.equal(status, 500);
          assert.match(JSON.stringify(body), /allowedHosts.*https/);
          assert.equal(JSON.stringify(body).includes(SECRET), false);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.equal(reported.length, 2);
    assert.deepEqual(unhandled, []);
  });

  test('reports a misconfigured deployment again after a minute', async () => {
    const reported: string[] = [];
    const target = channel({
      https: 'auto',
      onError: (error) => {
        reported.push(error.message);
      },
    });
    const realNow = Date.now;

    await send(target, toolCall('whoami'));
    await send(target, toolCall('whoami'));
    try {
      Date.now = () => realNow() + 60_000;
      await send(target, toolCall('whoami'));
    } finally {
      Date.now = realNow;
    }
    assert.equal(reported.length, 2);
  });

  // R5a: the waiver reads the address eve reports, not the Host header.
  test('under eve dev takes plain HTTP from a loopback peer only', async () => {
    process.env.EVE_DEV = '1';
    // No allowedHosts or https: the eve dev defaults are what is under test.
    const target = mcpServerChannel({
      auth: none(),
      name: 'test',
      route: '/mcp',
      tools: [whoami],
      version: '0.0.0',
    });

    for (const [requestIp, status] of [
      ['127.0.0.1', 200],
      ['192.168.1.218', 403],
    ] as const) {
      const response = await send(target, { ...toolCall('whoami'), requestIp });

      assert.equal(response.status, status, requestIp);
    }
  });

  // R4: withEve's dev rewrite hands eve 127.0.0.1 while the page is on localhost:3000.
  test('admits a page on an origin listed in allowedOrigins', async () => {
    const fromPage = {
      ...toolCall('whoami'),
      headers: {
        ...toolCall('whoami').headers,
        origin: 'http://localhost:3000',
      },
    };

    assert.equal((await send(channel(), fromPage)).status, 403);
    assert.equal(
      (
        await send(
          channel({ allowedOrigins: ['http://localhost:3000'] }),
          fromPage,
        )
      ).status,
      200,
    );
  });

  test('runs auth before reading the body', async () => {
    assert.equal(
      (await send(channel({ auth: () => null }), modern('tools/list'))).status,
      401,
    );
  });

  // Blocker 4: `true`, `{}` and `{ ok: false }` each reached a tool.
  test('fails closed when a strategy accepts without a principal', async () => {
    const before = calls;

    for (const accepted of [true, {}, { ok: false }]) {
      const target = channel({
        auth: (() => accepted) as unknown as AuthFn<Request>,
        onError: () => undefined,
      });

      assert.equal((await send(target, toolCall('whoami'))).status, 500);
    }
    assert.equal(calls, before);
  });

  test('adds resource_metadata to a refused OAuth request', async () => {
    const target = channel({
      auth: () => null,
      oauth: {
        issuer: 'https://auth.example',
        metadataPath: '/eve/v1/oauth-protected-resource/mcp',
        resource: 'https://app.example/eve/v1/mcp',
      },
    });
    const { headers } = await send(target, modern('tools/list'));

    assert.match(
      headers.get('www-authenticate') ?? '',
      /resource_metadata="https:\/\/app\.example\/eve\/v1\/oauth-protected-resource\/mcp"/,
    );
  });
});

describe('isolation and errors', () => {
  // Blocker 7: none() hands every caller the same object.
  test("keeps one caller from writing into the next caller's principal", async () => {
    const target = channel();

    await send(target, toolCall('vandal'));
    const { body } = await send(target, toolCall('whoami'));

    assert.equal((body as Result).result.structuredContent.team, null);
  });

  // Blocker 6a.
  test('keeps a throwing or rejecting reporter from reaching the client', async () => {
    for (const onToolError of [
      () => {
        throw new Error(SECRET);
      },
      async () => {
        throw new Error(SECRET);
      },
    ]) {
      const { body } = await send(
        channel({ onToolError }),
        toolCall('failing'),
      );

      assert.equal((body as Result).result.isError, true);
      assert.equal(JSON.stringify(body).includes(SECRET), false);
    }
  });

  // Blocker 6b.
  test('keeps a throwing input or output refinement from reaching the client', async () => {
    for (const era of [
      toolCall('refining', { value: 'x' }),
      legacy('tools/call', { arguments: { value: 'x' }, name: 'refining' }),
    ]) {
      const { body } = await send(channel(), era);

      assert.equal((body as Result).result.isError, true);
      assert.equal(JSON.stringify(body).includes(SECRET), false);
    }
  });

  test('still names the field a caller got wrong', async () => {
    const { body } = await send(channel(), toolCall('refining', { value: 3 }));

    assert.match(JSON.stringify(body), /value/);
  });
});

describe('schemas', () => {
  // C1: a schema whose JSON Schema conversion throws leaked on tools/list.
  test('keeps a throwing JSON Schema conversion out of tools/list', async () => {
    const base = z.object({});
    const undescribable = defineMcpTool({
      async call() {
        return { content: [] };
      },
      definition: {
        inputSchema: {
          '~standard': {
            ...base['~standard'],
            jsonSchema: {
              input: () => {
                throw new Error(SECRET);
              },
              output: () => {
                throw new Error(SECRET);
              },
            },
          },
        },
        name: 'undescribable',
      },
    });

    for (const era of [modern('tools/list'), legacy('tools/list')]) {
      const { body } = await send(channel({ tools: [undescribable] }), era);

      assert.equal(JSON.stringify(body).includes(SECRET), false);
    }
  });

  // N7: a server is built per request, so the same failure was reported on every tools/list.
  test('reports a schema that cannot be converted once, under one error id', async () => {
    const base = z.object({});
    const errorIds: string[] = [];
    const undescribable = defineMcpTool({
      async call() {
        return { content: [] };
      },
      definition: {
        inputSchema: {
          '~standard': {
            ...base['~standard'],
            jsonSchema: {
              input: () => {
                throw new Error(SECRET);
              },
              output: () => {
                throw new Error(SECRET);
              },
            },
          },
        },
        name: 'undescribable',
      },
    });
    const target = channel({
      onToolError: (_error, errorId) => {
        errorIds.push(errorId);
      },
      tools: [undescribable],
    });
    const answers: string[] = [];

    for (const era of [
      modern('tools/list'),
      legacy('tools/list'),
      modern('tools/list'),
    ]) {
      answers.push(JSON.stringify((await send(target, era)).body));
    }
    assert.equal(errorIds.length, 1);
    for (const answer of answers) {
      assert.ok(answer.includes(errorIds[0] ?? 'none'), answer);
    }
  });

  // C1: a rejection from a promise made in another realm slipped past `instanceof Promise`.
  test('keeps a foreign-realm rejection from reaching the client', async () => {
    const base = z.object({});
    const foreign = defineMcpTool({
      async call() {
        return { content: [] };
      },
      definition: {
        inputSchema: {
          '~standard': {
            ...base['~standard'],
            validate: () =>
              runInNewContext(
                `Promise.reject(new Error('${SECRET}'))`,
              ) as Promise<never>,
          },
        },
        name: 'foreign',
      },
    });

    for (const era of [
      toolCall('foreign'),
      legacy('tools/call', { arguments: {}, name: 'foreign' }),
    ]) {
      const { body } = await send(channel({ tools: [foreign] }), era);

      assert.equal((body as Result).result.isError, true);
      assert.equal(JSON.stringify(body).includes(SECRET), false);
    }
  });

  // C4: validation ran outside the batch bound, so a slow validator ran in parallel.
  test('validates inside the batch concurrency bound', async () => {
    const base = z.object({});
    let validating = 0;
    let peakValidating = 0;
    const slowlyChecked = defineMcpTool({
      async call() {
        return { content: [] };
      },
      definition: {
        inputSchema: {
          '~standard': {
            ...base['~standard'],
            validate: async (value: unknown) => {
              validating++;
              peakValidating = Math.max(peakValidating, validating);
              await new Promise((resolve) => setTimeout(resolve, 10));
              validating--;

              return { value };
            },
          },
        },
        name: 'slowly_checked',
      },
    });
    const batch = [1, 2, 3].map((id) => ({
      id,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'slowly_checked' },
    }));
    const { status } = await send(
      channel({ allowBatches: true, tools: [slowlyChecked] }),
      { body: batch, headers: { 'mcp-protocol-version': '2025-11-25' } },
    );

    assert.equal(status, 200);
    assert.equal(peakValidating, 1);
  });
});

describe('messages', () => {
  // Blocker 5.
  test('refuses subscriptions/listen before the SDK', async () => {
    const { body } = await send(
      channel(),
      modern('subscriptions/listen', { notifications: {} }),
    );

    assert.equal((body as { error: { code: number } }).error.code, -32_601);
  });

  // Blocker 9.
  test('refuses a 2025-era tools/call sent under Mcp-Method: tools/list', async () => {
    const before = calls;
    const { status } = await send(channel(), {
      ...legacy('tools/call', { arguments: {}, name: 'whoami' }),
      headers: {
        'mcp-method': 'tools/list',
        'mcp-protocol-version': '2025-11-25',
      },
    });

    assert.equal(status, 400);
    assert.equal(calls, before);
  });

  // Blocker 10.
  test('refuses batches by default, and caps and serialises allowed ones', async () => {
    const batch = (size: number) =>
      Array.from({ length: size }, (_, i) => ({
        id: i + 1,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: {}, name: 'slow' },
      }));
    const headers = { 'mcp-protocol-version': '2025-11-25' };

    assert.equal(
      (await send(channel(), { body: batch(2), headers })).status,
      400,
    );
    assert.equal(
      (
        await send(channel({ allowBatches: true }), {
          body: batch(11),
          headers,
        })
      ).status,
      400,
    );
    peak = 0;
    const allowed = await send(channel({ allowBatches: true }), {
      body: batch(3),
      headers,
    });

    assert.equal(allowed.status, 200);
    assert.equal((allowed.body as unknown[]).length, 3);
    assert.equal(peak, 1);
  });
});
