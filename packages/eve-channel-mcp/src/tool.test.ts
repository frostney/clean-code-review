import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import {
  defineMcpTool,
  guardSchema,
  McpToolOperationError,
  runToolCall,
} from './tool.js';

const SECRET = 'PRIVATE_DETAIL';

function throwSecret(): never {
  throw new Error(SECRET);
}

describe('runToolCall', () => {
  test('passes a result through', async () => {
    const result = { content: [{ text: 'ok', type: 'text' as const }] };

    assert.equal(await runToolCall(async () => result), result);
  });

  test('turns an McpToolOperationError into a tool error in its own words', async () => {
    const result = await runToolCall(async () => {
      throw new McpToolOperationError('conflict', 'Read it again first.');
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

  test('keeps any other failure from the client and reports it with an id', async () => {
    const reported: [unknown, string][] = [];
    const result = await runToolCall(
      throwSecret as () => never,
      (error, errorId) => {
        reported.push([error, errorId]);
      },
    );

    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.match(
      JSON.stringify(result.content),
      new RegExp(`errorId: ${reported[0]?.[1]}`),
    );
  });

  // Blocker 6a: the reporter's own throw used to become the client's message.
  test('returns the generic result when the reporter throws or rejects', async () => {
    const throwing = await runToolCall(throwSecret as () => never, () => {
      throw new Error(`reporter ${SECRET}`);
    });
    const rejecting = await runToolCall(
      throwSecret as () => never,
      async () => {
        throw new Error(`reporter ${SECRET}`);
      },
    );

    for (const result of [throwing, rejecting]) {
      assert.equal(result.isError, true);
      assert.equal(JSON.stringify(result).includes(SECRET), false);
    }
  });
});

describe('guardSchema', () => {
  const reported: unknown[] = [];
  const report = (error: unknown) => {
    reported.push(error);
  };

  // Blocker 6b: the SDK validates outside the callback and sent the throw to the client.
  test('turns a throwing refinement into one generic issue', async () => {
    const guarded = guardSchema(
      z.string().refine(throwSecret),
      'input',
      report,
    );
    const result = await guarded['~standard'].validate('x');

    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.match(JSON.stringify(result), /could not check this input/);
    assert.equal((reported.at(-1) as Error).message, SECRET);
  });

  test('keeps deliberate input feedback', async () => {
    const guarded = guardSchema(
      z.number().min(0, 'Must not be negative.'),
      'input',
      report,
    );
    const result = await guarded['~standard'].validate(-1);

    assert.match(JSON.stringify(result), /Must not be negative/);
  });

  test('logs, and does not send, why the server output failed its schema', async () => {
    const guarded = guardSchema(
      z.object({ count: z.number() }),
      'output',
      report,
    );
    const result = await guarded['~standard'].validate({ count: SECRET });

    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.match(JSON.stringify(result), /could not check this output/);
  });

  test('keeps the JSON Schema the SDK lists', () => {
    const schema = z.object({ celsius: z.number() });
    const guarded = guardSchema(schema, 'input', report);
    const target = { target: 'draft-2020-12' } as const;

    assert.deepEqual(
      guarded['~standard'].jsonSchema.input(target),
      schema['~standard'].jsonSchema.input(target),
    );
  });
});

describe('defineMcpTool types', () => {
  // Blocker 14: a result that contradicted the output schema compiled.
  test('ties structured content to the output schema', () => {
    const counted = defineMcpTool({
      async call() {
        return { content: [], structuredContent: { count: 1 } };
      },
      definition: {
        inputSchema: z.object({}),
        name: 'count',
        outputSchema: z.object({ count: z.number() }),
      },
    });

    defineMcpTool({
      // @ts-expect-error `count` is a number in the output schema
      async call() {
        return { content: [], structuredContent: { count: 'one' } };
      },
      definition: {
        inputSchema: z.object({}),
        name: 'miscount',
        outputSchema: z.object({ count: z.number() }),
      },
    });
    assert.equal(counted.name, 'count');
  });
});
