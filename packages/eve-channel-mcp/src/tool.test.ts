import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { McpToolOperationError, runToolCall } from './tool.js';

describe('runToolCall', () => {
  test('passes a result through', async () => {
    const result = { content: [{ text: 'ok', type: 'text' as const }] };

    assert.equal(await runToolCall(() => result), result);
  });

  test('turns an McpToolOperationError into a tool error in its own words', async () => {
    const result = await runToolCall(() => {
      throw new McpToolOperationError('conflict', 'Read it again first.', {
        retryable: true,
      });
    });

    assert.deepEqual(result, {
      content: [{ text: 'Read it again first.', type: 'text' }],
      isError: true,
      structuredContent: {
        error: {
          code: 'conflict',
          message: 'Read it again first.',
          retryable: true,
        },
      },
    });
  });

  test('keeps any other failure out of the result and reports it with an id', async () => {
    const reported: [unknown, string][] = [];
    const cause = new Error('ECONNREFUSED 10.0.0.7:5432');
    const result = await runToolCall(
      () => {
        throw cause;
      },
      (error, errorId) => reported.push([error, errorId]),
    );
    const [first] = reported;

    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('ECONNREFUSED'), false);
    assert.equal(first?.[0], cause);
    assert.match(
      JSON.stringify(result.content),
      new RegExp(`errorId: ${first?.[1]}`),
    );
  });
});
