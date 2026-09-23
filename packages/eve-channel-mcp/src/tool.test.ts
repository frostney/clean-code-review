import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runInNewContext } from 'node:vm';

import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  defineMcpTool,
  describeOnly,
  executeTool,
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

describe('executeTool', () => {
  const reported: unknown[] = [];
  const report = (error: unknown) => {
    reported.push(error);
  };
  const signal = new AbortController().signal;
  const echo = async (value: unknown) => ({
    content: [],
    structuredContent: value as Record<string, unknown>,
  });
  const run = (
    inputSchema: StandardSchemaWithJSON,
    value: unknown,
    outputSchema?: StandardSchemaWithJSON,
  ) =>
    executeTool(
      { inputSchema, name: 'probe', ...(outputSchema ? { outputSchema } : {}) },
      echo,
      value,
      signal,
      report,
    );

  test('turns a throwing refinement into one generic issue', async () => {
    const result = await run(z.object({ v: z.string().refine(throwSecret) }), {
      v: 'x',
    });

    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.match(JSON.stringify(result), /could not check this input/);
    assert.equal((reported.at(-1) as Error).message, SECRET);
  });

  // C1: `instanceof Promise` missed a promise from another realm, and its
  // rejection reached the client.
  test('catches a rejection from a promise made in another realm', async () => {
    const base = z.object({ v: z.string() });
    const foreign: StandardSchemaWithJSON = {
      '~standard': {
        ...base['~standard'],
        validate: () =>
          runInNewContext(
            `Promise.reject(new Error('${SECRET}'))`,
          ) as Promise<never>,
      },
    };
    const result = await run(foreign, { v: 'x' });

    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.match(JSON.stringify(result), /could not check this input/);
  });

  test('keeps deliberate input feedback, in the SDK wording', async () => {
    const result = await run(
      z.object({ n: z.number().min(0, 'Must not be negative.') }),
      {
        n: -1,
      },
    );

    assert.deepEqual(result.content, [
      {
        text: 'Input validation error: Invalid arguments for tool probe: n: Must not be negative.',
        type: 'text',
      },
    ]);
  });

  test('logs, and does not send, why the server output failed its schema', async () => {
    const result = await run(
      z.object({ count: z.unknown() }),
      { count: SECRET },
      z.object({ count: z.number() }),
    );

    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.match(JSON.stringify(result), /could not check this output/);
  });

  test('does not start the call once the client has gone', async () => {
    const gone = new AbortController();
    let called = false;

    gone.abort();
    const result = await executeTool(
      { inputSchema: z.object({}), name: 'probe' },
      async () => {
        called = true;

        return { content: [] };
      },
      {},
      gone.signal,
      report,
    );

    assert.equal(called, false);
    assert.equal(result.isError, true);
  });
});

describe('describeOnly', () => {
  const target = { target: 'draft-2020-12' } as const;

  test('keeps the JSON Schema the SDK lists, and leaves validation to executeTool', async () => {
    const schema = z.object({ celsius: z.number() });
    const described = describeOnly(schema, () => undefined);

    assert.deepEqual(
      described['~standard'].jsonSchema.input(target),
      schema['~standard'].jsonSchema.input(target),
    );
    assert.deepEqual(await described['~standard'].validate('anything'), {
      value: 'anything',
    });
  });

  // C1: a throwing conversion's text reached the client on tools/list.
  test('replaces a throwing conversion with a generic message', () => {
    const base = z.object({});
    const reported: unknown[] = [];
    const described = describeOnly(
      {
        '~standard': {
          ...base['~standard'],
          jsonSchema: { input: throwSecret, output: throwSecret },
        },
      },
      (error) => {
        reported.push(error);
      },
    );

    assert.throws(
      () => described['~standard'].jsonSchema.input(target),
      (error: Error) =>
        !error.message.includes(SECRET) &&
        /could not describe this tool/.test(error.message),
    );
    assert.equal((reported[0] as Error).message, SECRET);
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
