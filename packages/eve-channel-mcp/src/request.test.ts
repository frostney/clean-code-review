import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { readJsonRpcBody } from './request.js';

const ENDPOINT = 'https://agent.example/mcp';
const HUNG_MS = 2000;

function post(body: BodyInit, headers: Record<string, string> = {}): Request {
  // `duplex` is required for a stream body and missing from the DOM typings.
  return new Request(ENDPOINT, {
    body,
    duplex: 'half',
    headers,
    method: 'POST',
  } as RequestInit);
}

/** A body that sends `bytes`, then stays open, as a slow or hostile uploader would. */
function openStream(bytes: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(bytes)));
    },
  });
}

function withinTime<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('the body read hung')), HUNG_MS),
    ),
  ]);
}

async function status(body: Awaited<ReturnType<typeof readJsonRpcBody>>) {
  return body.ok
    ? { status: 200 }
    : {
        code: (await body.response.json()).error.code,
        status: body.response.status,
      };
}

const limits = { maxBodyBytes: 64, timeoutMs: 5000 };

describe('readJsonRpcBody', () => {
  test('returns the parsed message', async () => {
    const body = await readJsonRpcBody(
      post('{"jsonrpc":"2.0","id":1}'),
      limits,
    );

    assert.deepEqual(body, { ok: true, value: { id: 1, jsonrpc: '2.0' } });
  });

  // Blocker 1: a clone read past the limit awaited a cancel that waits on
  // the unread branch, so this never answered.
  test('answers 413 at once when an open upload passes the limit', async () => {
    const body = await withinTime(
      readJsonRpcBody(post(openStream(65)), limits),
    );

    assert.deepEqual(await status(body), { code: -32_000, status: 413 });
  });

  test('answers 413 for a declared length past the limit without reading', async () => {
    const body = await withinTime(
      readJsonRpcBody(post(openStream(1), { 'content-length': '65' }), limits),
    );

    assert.equal((await status(body)).status, 413);
  });

  // Blocker 1: a caller under the limit could hold the read open for ever.
  test('answers 408 when an upload under the limit stalls', async () => {
    const body = await withinTime(
      readJsonRpcBody(post(openStream(10)), { ...limits, timeoutMs: 50 }),
    );

    assert.deepEqual(await status(body), { code: -32_000, status: 408 });
  });

  test('turns a failing upload into a parse error, not a thrown one', async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    const body = await withinTime(readJsonRpcBody(post(failing), limits));

    assert.deepEqual(await status(body), { code: -32_700, status: 400 });
  });

  test('answers a body that is not JSON with a parse error', async () => {
    for (const text of ['{', '']) {
      assert.deepEqual(
        await status(await readJsonRpcBody(post(text), limits)),
        {
          code: -32_700,
          status: 400,
        },
      );
    }
  });
});
