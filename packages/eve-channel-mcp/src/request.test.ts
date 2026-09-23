import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { crossOriginRefusal, readJsonRpcBody } from './request.js';

const ENDPOINT = 'https://agent.example/mcp';

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, { body, headers, method: 'POST' });
}

describe('crossOriginRefusal', () => {
  test('lets a request without Origin through, as non-browser clients send', () => {
    assert.equal(crossOriginRefusal(post('{}')), null);
  });

  test('lets a same-origin browser request through', () => {
    assert.equal(
      crossOriginRefusal(post('{}', { origin: 'https://agent.example' })),
      null,
    );
  });

  test('refuses another origin and a malformed one with 403', async () => {
    for (const origin of ['https://evil.example', 'not a url']) {
      const refused = crossOriginRefusal(post('{}', { origin }));

      assert.ok(refused);
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).error.code, -32_000);
    }
  });
});

describe('readJsonRpcBody', () => {
  const limits = { allowBatches: false, maxBodyBytes: 64 };

  test('returns the parsed message and leaves the request readable', async () => {
    const request = post('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    const body = await readJsonRpcBody(request, limits);

    assert.deepEqual(body, {
      ok: true,
      value: { id: 1, jsonrpc: '2.0', method: 'tools/list' },
    });
    assert.equal(request.bodyUsed, false);
  });

  test('refuses a body past the limit, declared or streamed', async () => {
    const declared = await readJsonRpcBody(
      post('{}', { 'content-length': '65' }),
      limits,
    );
    const streamed = await readJsonRpcBody(post(`"${'x'.repeat(80)}"`), limits);

    for (const body of [declared, streamed]) {
      assert.equal(body.ok, false);
      assert.equal(body.ok ? 0 : body.response.status, 413);
    }
  });

  test('answers a body that is not JSON with a parse error', async () => {
    for (const text of ['{', '']) {
      const body = await readJsonRpcBody(post(text), limits);

      assert.equal(body.ok ? 0 : body.response.status, 400);
      assert.equal(
        body.ok ? 0 : (await body.response.json()).error.code,
        -32_700,
      );
    }
  });

  test('refuses a batch unless batches are allowed', async () => {
    const batch = '[{"jsonrpc":"2.0","id":1,"method":"ping"}]';
    const refused = await readJsonRpcBody(post(batch), limits);
    const allowed = await readJsonRpcBody(post(batch), {
      ...limits,
      allowBatches: true,
    });

    assert.equal(
      refused.ok ? 0 : (await refused.response.json()).error.code,
      -32_600,
    );
    assert.equal(allowed.ok, true);
  });
});
