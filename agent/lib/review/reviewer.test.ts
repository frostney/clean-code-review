/**
 * A reviewer that stops answering must end as a failure the page can show,
 * not a hang, and must settle spend for the prompt alone when nothing
 * streamed. Node's mock timers stand in for the wait, so the real bounds are
 * exercised without the wall-clock seconds or any model spend.
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV4, MockProviderV4 } from 'ai/test';

import {
  emptyReviewUsage,
  planReview,
  REVIEWER_TIMEOUT,
  reviewEstimateUsd,
  reviewSettleUsd,
  runReview,
  TIMED_OUT,
} from './reviewer';
import { REVIEWER_MODEL } from './summary';

const input = {
  files: [{ content: 'export const total = 1 + 2;\n', path: 'src/total.ts' }],
  judgments: {},
};

/** Streams `deltas`, then nothing. A fetch-based provider ends its stream when the signal aborts, so the mock does too. */
function stalling(deltas: string[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ id: 'part', type: 'text-start' });
          for (const delta of deltas) {
            controller.enqueue({ delta, id: 'part', type: 'text-delta' });
          }
          abortSignal?.addEventListener('abort', () =>
            controller.error(abortSignal.reason),
          );
        },
      }),
    }),
  });
}

function reviewerIs(model: MockLanguageModelV4): void {
  (
    globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }
  ).AI_SDK_DEFAULT_PROVIDER = new MockProviderV4({
    languageModels: { [REVIEWER_MODEL]: model },
  });
}

/** Enough turns for the SDK to arm its timers and for an abort to reach every part. */
const SETTLE_TURNS = 40;

async function settle(): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

type Outcome = Promise<Error | null>;

async function stillRunning(outcome: Outcome): Promise<boolean> {
  const done = outcome.then(() => 'done');
  return (
    (await Promise.race([done, settle().then(() => 'running')])) === 'running'
  );
}

interface Stalled {
  outcome: Outcome;
  usage: ReturnType<typeof emptyReviewUsage>;
  reservedUsd: number;
}

/** Starts a review against `model` with the clock stopped just after the bounds are armed. */
async function stalledReview(model: MockLanguageModelV4): Promise<Stalled> {
  reviewerIs(model);
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout'] });
  const plan = await planReview(input);
  const usage = emptyReviewUsage();
  const run = runReview(
    plan,
    () => {
      /* The page's sink; the text is not what these tests assert. */
    },
    undefined,
    usage,
  );
  const outcome = run.then(
    () => null,
    (err: Error) => err,
  );
  // The bounds are only armed once the parts have reached the model.
  await settle();
  return { outcome, reservedUsd: reviewEstimateUsd(plan), usage };
}

async function failedAt(stalled: Stalled, bound: number): Promise<Error> {
  mock.timers.tick(bound - 1);
  assert.ok(await stillRunning(stalled.outcome), 'failed before the bound');
  mock.timers.tick(2);
  await settle();
  const error = await stalled.outcome;
  assert.ok(error, 'the stalled review resolved instead of failing');
  assert.ok(
    reviewSettleUsd(stalled.usage) < stalled.reservedUsd,
    'settled at or above the reservation',
  );
  return error;
}

test('a first chunk that never arrives fails within the bound', async () => {
  const stalled = await stalledReview(stalling([]));
  try {
    const error = await failedAt(stalled, REVIEWER_TIMEOUT.firstChunkMs);
    // What the reader is shown, so it names no timer and carries no advice.
    assert.equal(error.message, TIMED_OUT.firstChunk);
    assert.equal(stalled.usage.outputTokens, 0);
    assert.equal(stalled.usage.costUsd, 0);
    // The prompt was sent, so it is counted; the output that never came is not.
    assert.ok(
      stalled.usage.unreportedUsd > 0,
      'the sent prompt went uncounted',
    );
  } finally {
    mock.timers.reset();
  }
});

test('a stream that stops mid-answer fails within the bound', async () => {
  const stalled = await stalledReview(
    stalling(['Decision: comment\n', '## Overall\nThe review starts']),
  );
  try {
    const error = await failedAt(stalled, REVIEWER_TIMEOUT.chunkMs);
    assert.equal(error.message, TIMED_OUT.chunk);
    assert.ok(
      stalled.usage.unreportedUsd > 0,
      'the streamed answer went uncounted',
    );
  } finally {
    mock.timers.reset();
  }
});
