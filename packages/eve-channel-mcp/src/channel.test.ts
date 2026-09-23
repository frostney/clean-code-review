import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RouteHandlerArgs } from 'eve/channels';
import { type AuthFn, none, oauthResource } from 'eve/channels/auth';
import { z } from 'zod';

import { type McpServerChannelOptions, mcpServerChannel } from './channel.js';
import { defineMcpTool } from './tool.js';

const ENDPOINT = 'http://127.0.0.1/mcp';
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

const whoami = defineMcpTool({
  call(_input, { auth, requestIp }) {
    const principal = { principalId: auth.principalId, requestIp };

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
    }),
  },
});

const failing = defineMcpTool({
  call() {
    throw new Error('database password in this message');
  },
  definition: { inputSchema: z.object({}), name: 'failing' },
});

function channel(overrides: Partial<McpServerChannelOptions> = {}) {
  return mcpServerChannel({
    auth: none(),
    name: 'test',
    route: '/mcp',
    tools: [whoami, failing],
    version: '0.0.0',
    ...overrides,
  });
}

async function call(
  target: ReturnType<typeof channel>,
  init: { body?: unknown; headers?: Record<string, string>; method?: string },
): Promise<{ status: number; body: unknown }> {
  const method = init.method ?? 'POST';
  const route = target.routes.find(
    (r) => r.method === method && r.path === '/mcp',
  );

  assert.ok(route && route.transport !== 'websocket');
  const response = await route.handler(
    new Request(ENDPOINT, {
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...init.headers,
      },
      method,
    }),
    CHANNEL,
  );
  const text = await response.text();
  const events = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)));
  const body = events.length > 1 ? events : (events[0] ?? JSON.parse(text));

  return { body, status: response.status };
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

describe('mcpServerChannel options', () => {
  test('requires auth, a route and something to serve', () => {
    assert.throws(
      () => channel({ auth: undefined as unknown as AuthFn<Request> }),
      /requires auth/,
    );
    assert.throws(() => channel({ route: 'mcp' }), /route/);
    assert.throws(() => channel({ tools: [] }), /tools, register/);
    assert.throws(() => channel({ tools: [whoami, whoami] }), /unique/);
  });

  test('answers POST, GET and DELETE at the route', () => {
    assert.deepEqual(
      channel().routes.map((r) => `${r.method} ${r.path}`),
      ['POST /mcp', 'GET /mcp', 'DELETE /mcp'],
    );
  });

  test('publishes protected-resource metadata for an oauthResource() policy', () => {
    const paths = channel({
      auth: oauthResource(none(), { issuer: 'https://auth.example' }),
    }).routes.map((r) => `${r.method} ${r.path}`);

    assert.ok(paths.includes('GET /.well-known/oauth-protected-resource/mcp'));
  });
});

describe('serving', () => {
  test('hands a tool its principal and address in the modern era', async () => {
    const { body, status } = await call(
      channel(),
      modern('tools/call', { arguments: {}, name: 'whoami' }),
    );

    assert.equal(status, 200);
    assert.deepEqual(
      (body as { result: { structuredContent: unknown } }).result
        .structuredContent,
      {
        principalId: 'anonymous',
        requestIp: '203.0.113.9',
      },
    );
  });

  test('hands a tool its principal in the 2025 era', async () => {
    const { body } = await call(
      channel(),
      legacy('tools/call', { arguments: {}, name: 'whoami' }),
    );

    assert.equal(
      (body as { result: { structuredContent: { principalId: string } } })
        .result.structuredContent.principalId,
      'anonymous',
    );
  });

  test('passes the SDK server to register, with the era', async () => {
    const eras: string[] = [];
    const target = channel({
      register(server, { era }) {
        eras.push(era);
        server.registerTool(
          'extra',
          { inputSchema: z.object({}) },
          async () => ({ content: [{ text: era, type: 'text' }] }),
        );
      },
    });
    const { body } = await call(target, modern('tools/list'));
    const names = (
      body as { result: { tools: { name: string }[] } }
    ).result.tools.map((t) => t.name);

    await call(target, legacy('tools/list'));
    assert.deepEqual(names, ['whoami', 'failing', 'extra']);
    assert.deepEqual(eras, ['modern', 'legacy']);
  });

  test('reports an unexpected tool failure and keeps it from the client', async () => {
    const reported: unknown[] = [];
    const { body } = await call(
      channel({ onToolError: (error) => reported.push(error) }),
      modern('tools/call', { arguments: {}, name: 'failing' }),
    );

    assert.equal(reported.length, 1);
    assert.equal(JSON.stringify(body).includes('password'), false);
  });

  test('refuses a batch unless allowed', async () => {
    const batch = [
      { id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} },
      { id: 2, jsonrpc: '2.0', method: 'tools/list', params: {} },
    ];
    const headers = { 'mcp-protocol-version': '2025-11-25' };
    const refused = await call(channel(), { body: batch, headers });
    const allowed = await call(channel({ allowBatches: true }), {
      body: batch,
      headers,
    });

    assert.equal(refused.status, 400);
    assert.equal(allowed.status, 200);
    assert.equal((allowed.body as unknown[]).length, 2);
  });

  test('runs auth before anything else', async () => {
    const { status } = await call(
      channel({ auth: () => null }),
      modern('tools/list'),
    );

    assert.equal(status, 401);
  });

  test('answers GET with 405, as a stateless server', async () => {
    const { status } = await call(channel(), { method: 'GET' });

    assert.equal(status, 405);
  });
});
