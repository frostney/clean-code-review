import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { messageRefusal } from './messages.js';

const LIMITS = { concurrency: 1, maxMessages: 3 };
const META = {
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
};

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1/mcp', { headers, method: 'POST' });
}

function call(name: string, params: Record<string, unknown> = {}) {
  return {
    id: 1,
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { arguments: {}, name, ...params },
  };
}

async function refusal(
  headers: Record<string, string>,
  body: unknown,
  limits: typeof LIMITS | null = null,
) {
  const response = await messageRefusal(request(headers), body, limits);

  return (
    response && {
      code: (await response.json()).error.code,
      status: response.status,
    }
  );
}

describe('messageRefusal', () => {
  test('refuses a batch unless batches are allowed', async () => {
    assert.deepEqual(await refusal({}, [call('a')]), {
      code: -32_600,
      status: 400,
    });
    assert.equal(await refusal({}, [call('a'), call('b')], LIMITS), null);
  });

  // Blocker 10: one admitted request ran a hundred tools.
  test('caps the messages in an allowed batch', async () => {
    const four = [call('a'), call('b'), call('c'), call('d')];

    assert.deepEqual(await refusal({}, four, LIMITS), {
      code: -32_600,
      status: 400,
    });
    assert.deepEqual(await refusal({}, [], LIMITS), {
      code: -32_600,
      status: 400,
    });
  });

  // Blocker 5: each request's bus is private, so a stream would wait for nothing.
  test('refuses subscriptions/listen, alone or in a batch', async () => {
    const listen = {
      id: 7,
      jsonrpc: '2.0',
      method: 'subscriptions/listen',
      params: { _meta: META },
    };

    assert.deepEqual(
      await refusal({ 'mcp-method': 'subscriptions/listen' }, listen),
      {
        code: -32_601,
        status: 200,
      },
    );
    assert.deepEqual(await refusal({}, [call('a'), listen], LIMITS), {
      code: -32_601,
      status: 200,
    });
  });

  // Blocker 9: a policy keyed on Mcp-Method saw tools/list while the body called a tool.
  test('refuses a 2025-era body whose routing headers name another operation', async () => {
    assert.deepEqual(
      await refusal({ 'mcp-method': 'tools/list' }, call('delete_all')),
      {
        code: -32_020,
        status: 400,
      },
    );
    assert.deepEqual(
      await refusal(
        { 'mcp-method': 'tools/call', 'mcp-name': 'read' },
        call('delete_all'),
      ),
      { code: -32_020, status: 400 },
    );
    assert.deepEqual(await refusal({ 'mcp-name': 'a' }, [call('a')], LIMITS), {
      code: -32_020,
      status: 400,
    });
  });

  test('passes 2025-era headers that agree, and leaves 2026 requests to the SDK', async () => {
    assert.equal(
      await refusal(
        { 'mcp-method': 'tools/call', 'mcp-name': 'read' },
        call('read'),
      ),
      null,
    );
    assert.equal(
      await refusal(
        { 'mcp-method': 'tools/list' },
        call('delete_all', { _meta: META }),
      ),
      null,
    );
  });
});
