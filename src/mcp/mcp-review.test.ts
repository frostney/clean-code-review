import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { SpendBrake } from '@/agent/lib/spend/spend';

import { MCP_MAX_DURATION_SECONDS } from './mcp-facts';
import { renderReviewText, reviewOutputSchema } from './mcp-result';
import { JUDGE_DEADLINE_MS, judgeCode, ReviewError } from './mcp-review';

test('the route lives as long as the deadlines assume', () => {
  const route = readFileSync(
    new URL('../app/api/mcp/route.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    route,
    new RegExp(`export const maxDuration = ${MCP_MAX_DURATION_SECONDS};`),
  );
  assert.ok(JUDGE_DEADLINE_MS > 0);
});

/** Records what was reserved and what it settled to. */
function brake() {
  const log = { reserved: 0, settled: [] as number[] };
  const spend: SpendBrake = {
    reserve(estimateUsd) {
      log.reserved = estimateUsd;

      return Promise.resolve({
        hold: {
          reservedUsd: estimateUsd,
          settle(actualUsd) {
            log.settled.push(actualUsd);

            return Promise.resolve();
          },
        },
        ok: true,
      });
    },
  };

  return { log, spend };
}

/**
 * A gateway that never answers `stuck`'s calls until they are aborted, and
 * answers the rest as Jev would.
 */
function stalledGateway(stuck: string, refused = '') {
  const real = globalThis.fetch;
  const key = process.env.AI_GATEWAY_API_KEY;

  process.env.AI_GATEWAY_API_KEY = 'test';
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, { type: string; criteria?: string[] }>;
      state: { path: string };
    };

    if (body.state.path === refused) {
      return Response.json(
        { error: { message: 'bad request', type: 'invalid_request_error' } },
        { status: 400 },
      );
    }
    if (body.state.path === stuck) {
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        );
      });
    }
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([id, q]) => {
        const levels = q.criteria?.length ?? 1;

        return [
          id,
          q.type === 'score'
            ? {
                probabilities: Object.fromEntries(
                  Array.from({ length: levels }, (_, i) => [
                    String(i),
                    i === 0 ? 1 : 0,
                  ]),
                ),
                score: 0,
                type: 'score',
              }
            : { probability: 0.1, type: 'boolean' },
        ];
      }),
    );

    return Response.json({
      answers,
      providerMetadata: { gateway: { cost: '0' } },
      usage: { inputTokens: 10, outputTokens: 1 },
      warnings: [],
    });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = real;
    if (key === undefined) {
      delete process.env.AI_GATEWAY_API_KEY;
    } else {
      process.env.AI_GATEWAY_API_KEY = key;
    }
  };
}

const live = new AbortController().signal;

test('a deadline with nothing answered refuses and still settles', async () => {
  const restore = stalledGateway('stuck.ts');
  const { log, spend } = brake();

  try {
    await assert.rejects(
      judgeCode(
        [{ content: 'const stuck = 1;', path: 'stuck.ts' }],
        live,
        AbortSignal.timeout(200),
        spend,
      ),
      (err) =>
        err instanceof ReviewError && /judging stopped/.test(err.message),
    );
    assert.ok(log.reserved > 0);
    assert.equal(log.settled.length, 1);
    assert.ok(log.settled[0] < log.reserved);
  } finally {
    restore();
  }
});

test('a deadline returns the files that answered and settles', async () => {
  const restore = stalledGateway('stuck.ts');
  const { log, spend } = brake();

  try {
    const judged = await judgeCode(
      [
        { content: 'const quick = 1;', path: 'quick.ts' },
        { content: 'const stuck = 2;', path: 'stuck.ts' },
      ],
      live,
      AbortSignal.timeout(200),
      spend,
    );

    assert.ok(judged.result.files['quick.ts']);
    assert.equal(judged.result.files['stuck.ts'], undefined);
    assert.deepEqual(judged.stopped, ['stuck.ts']);
    assert.equal(log.settled.length, 1);
  } finally {
    restore();
  }
});

test('a file that failed before the deadline is not blamed on it', async () => {
  const restore = stalledGateway('stuck.ts', 'refused.ts');
  const { log, spend } = brake();

  try {
    const judged = await judgeCode(
      [
        { content: 'const quick = 1;', path: 'quick.ts' },
        { content: 'const refused = 2;', path: 'refused.ts' },
        { content: 'const stuck = 3;', path: 'stuck.ts' },
      ],
      live,
      AbortSignal.timeout(300),
      spend,
    );

    assert.equal(judged.errors.length, 2);
    assert.deepEqual(judged.stopped, ['stuck.ts']);
    assert.equal(log.settled.length, 1);
  } finally {
    restore();
  }
});

test('a text-only client is told which files were partly judged', () => {
  const file = {
    answers: {},
    cached: false,
    kind: 'diff' as const,
    path: 'a.ts',
    review: null,
    reviewIncomplete: false,
    truncated: false,
  };
  const text = renderReviewText({
    cache: { judgedFromCache: 0, pullRequest: null, review: false },
    costUsd: { judge: 0, review: 0, total: 0 },
    decision: null,
    files: [
      {
        ...file,
        coverage: {
          complete: false,
          note: 'Jev answered for 1 of this file’s 2 parts.',
          parts: 2,
          partsJudged: 1,
        },
      },
      {
        ...file,
        coverage: { complete: true, note: null, parts: 1, partsJudged: 1 },
        path: 'b.ts',
      },
    ],
    models: { judge: 'jev', reviewer: 'luna' },
    ms: 0,
    notices: [],
    notJudged: [],
    overall: null,
    overallIncomplete: false,
    prose: [],
    source: { kind: 'paste' },
    unlistedFiles: 0,
  });

  assert.match(text, /### a\.ts \(diff, partly judged\)/);
  assert.match(
    text,
    /Partly judged: Jev answered for 1 of this file’s 2 parts\./,
  );
  assert.match(text, /### b\.ts \(diff\)/);
});

test('the published output schema admits fields added later', () => {
  const schema = (
    reviewOutputSchema as unknown as {
      '~standard': {
        jsonSchema: { output: (o: { target: string }) => unknown };
      };
    }
  )['~standard'].jsonSchema.output({ target: 'draft-2020-12' });
  const closed: string[] = [];
  const walk = (node: unknown, at: string) => {
    if (Array.isArray(node)) {
      for (const [i, n] of node.entries()) {
        walk(n, `${at}[${i}]`);
      }
    } else if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;

      if (o.type === 'object' && o.additionalProperties === false) {
        closed.push(at);
      }
      for (const [k, v] of Object.entries(o)) {
        walk(v, `${at}.${k}`);
      }
    }
  };

  walk(schema, '$');
  assert.deepEqual(closed, []);
});
