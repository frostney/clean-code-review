/**
 * Jev in eve's model slot.
 *
 * Jev evaluates state against typed questions; it does not chat. eve's
 * `model` takes AI SDK language models, so this is the smallest thing that
 * satisfies that contract. It handles two kinds of turn:
 *
 *  - judge:     run judge.ts on the review in the message; reply with the
 *               result as JSON text.
 *  - summarize: run reviewer.ts — parallel Luna calls, one per batch of files
 *               plus one for the decision — and stream the combined review
 *               text as this turn's reply. The page reads the turn's own
 *               stream; cancelling the turn aborts the calls.
 *
 * Anything else gets a bare acknowledgement. Sessions, streaming, limits and
 * Agent Runs all work as for any other model.
 *
 * Both kinds of turn answer to the page's model budget (`./budgets.ts`), every
 * tab together. This is the one place every page turn passes through, and the
 * only place that knows both what a turn is about to run and what it cost,
 * which is why the brake sits here rather than in a channel or a route: a
 * turn reserves an estimate for the work the cache cannot answer before it
 * starts, and settles to what it plausibly cost once it stops, whether it
 * finished, failed or was cancelled (`./spend.ts`). A refused turn is not a
 * failure: its whole reply is a `pausedReply`, which the page shows as a
 * notice. The MCP endpoint calls the same judge and reviewer without this
 * adapter, and counts against a budget of its own.
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';

import {
  PAGE_DAILY_BUDGET_USD,
  PAGE_HOURLY_BUDGET_USD,
  pausedReply,
} from './budgets';
import {
  JEV,
  JudgeFailedError,
  judgeChargeUsd,
  judgeEstimateUsd,
  judgeReview,
} from './judge';
import { parseMessage, type SummarizeInput } from './prompt';
import {
  emptyReviewUsage,
  planReview,
  type ReviewUsage,
  reviewChargeUsd,
  reviewEstimateUsd,
  runReview,
} from './reviewer';
import { createSpendBrake, type Hold } from './spend';
import { REVIEWER_MODEL } from './summary';

/** Every page turn, in every tab and every instance, counted together. */
const pageSpend = createSpendBrake('page', {
  dayUsd: PAGE_DAILY_BUDGET_USD,
  hourUsd: PAGE_HOURLY_BUDGET_USD,
});

/**
 * Reserve `estimateUsd` for a turn about to start, or the reply for a turn the
 * budget refuses. A turn whose work is all in the cache estimates nothing and
 * is never refused.
 */
async function admit(
  estimateUsd: number,
): Promise<{ hold: Hold } | { paused: string }> {
  const admission = await pageSpend.reserve(estimateUsd);
  return admission.ok
    ? { hold: admission.hold }
    : { paused: pausedReply(admission.window, admission.resetsAt) };
}

/**
 * Run a planned review against its reservation, and settle it with whatever
 * the run cost, finished, failed or cancelled.
 */
async function reviewWithin(
  hold: Hold,
  plan: Awaited<ReturnType<typeof planReview>>,
  emit: (delta: string) => void,
  signal: AbortSignal | undefined,
) {
  const usage = emptyReviewUsage();
  try {
    return await runReview(plan, emit, signal, usage);
  } finally {
    await hold.settle(reviewChargeUsd(usage));
  }
}

/** Plan a review and reserve for its uncached parts. */
async function admitReview(input: SummarizeInput) {
  const plan = await planReview(input);
  return { plan, ...(await admit(reviewEstimateUsd(plan))) };
}

function lastUserText(options: LanguageModelV4CallOptions): string {
  const last = [...options.prompt].reverse().find((m) => m.role === 'user');
  return last?.role === 'user'
    ? last.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    : '';
}

const tokens = (n: number) => ({
  cacheRead: undefined,
  cacheWrite: undefined,
  noCache: n,
  total: n,
});
const usageOf = (input: number, output: number): LanguageModelV4Usage => ({
  inputTokens: tokens(input),
  outputTokens: { reasoning: undefined, text: output, total: output },
});
const finished = { raw: 'stop', unified: 'stop' as const };

/** Metadata the page reads off `step.completed`: the gateway's cost for eve's budget, and what the review was. */
function reviewMetadata(usage: ReviewUsage) {
  return {
    gateway: { cost: String(usage.costUsd) },
    judge: { cached: usage.cached, kind: 'summary', model: REVIEWER_MODEL },
  };
}

function textResult(
  text: string,
  extra: Partial<LanguageModelV4GenerateResult> = {},
): LanguageModelV4GenerateResult {
  return {
    content: [{ text, type: 'text' }],
    finishReason: finished,
    response: { modelId: JEV, timestamp: new Date() },
    usage: usageOf(0, 0),
    warnings: [],
    ...extra,
  };
}

async function judge(
  options: LanguageModelV4CallOptions,
  input: Parameters<typeof judgeReview>[0],
): Promise<LanguageModelV4GenerateResult> {
  const admitted = await admit(await judgeEstimateUsd(input.files));
  if ('paused' in admitted) {
    return textResult(admitted.paused);
  }
  let judged: Awaited<ReturnType<typeof judgeReview>>;
  try {
    judged = await judgeReview(input, options.abortSignal);
  } catch (err) {
    // Every file failed or was cancelled: settled at what those attempts
    // plausibly cost, which is nothing for a gateway that turned them away.
    // Anything else is a fault here, and keeps the reservation.
    if (err instanceof JudgeFailedError) {
      await admitted.hold.settle(err.spentUsd);
    }
    throw err;
  }
  await admitted.hold.settle(judgeChargeUsd(judged));
  const { result, cost, warnings, errors } = judged;
  return textResult(JSON.stringify({ kind: 'judged', ...result }), {
    // eve's per-session cost limit and the page footer read the gateway's cost from here.
    providerMetadata: {
      gateway: { cost: String(cost) },
      judge: { kind: 'judged', model: result.model },
    },
    response: { modelId: result.model, timestamp: new Date() },
    usage: usageOf(result.usage.input_tokens, result.usage.output_tokens),
    // A file Jev could not judge is absent from the result; say why in the
    // step's warnings so Agent Runs shows it.
    warnings: [
      ...warnings,
      ...errors.map((message) => ({ message, type: 'other' as const })),
    ],
  });
}

async function generate(
  options: LanguageModelV4CallOptions,
): Promise<LanguageModelV4GenerateResult> {
  const parsed = parseMessage(lastUserText(options));
  if (parsed.kind === 'other') {
    return textResult(JSON.stringify({ kind: 'ack' }));
  }
  if (parsed.kind === 'judge') {
    return judge(options, parsed.input);
  }
  const admitted = await admitReview(parsed.input);
  if ('paused' in admitted) {
    return textResult(admitted.paused);
  }
  const { text, usage } = await reviewWithin(
    admitted.hold,
    admitted.plan,
    () => {
      /* A generate call has nobody to stream to; the whole text is the result. */
    },
    options.abortSignal,
  );
  return textResult(text, {
    providerMetadata: reviewMetadata(usage),
    response: { modelId: REVIEWER_MODEL, timestamp: new Date() },
    usage: usageOf(usage.inputTokens, usage.outputTokens),
  });
}

export function jev(): LanguageModelV4 {
  return {
    doGenerate: generate,
    async doStream(options) {
      const parsed = parseMessage(lastUserText(options));
      if (parsed.kind !== 'summarize') {
        // Judge turns and acknowledgements arrive whole.
        const r = await generate(options);
        const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
        const parts: LanguageModelV4StreamPart[] = [
          { type: 'stream-start', warnings: r.warnings },
          { type: 'response-metadata', ...r.response },
          { id: 'jev', type: 'text-start' },
          { delta: text, id: 'jev', type: 'text-delta' },
          { id: 'jev', type: 'text-end' },
          {
            finishReason: r.finishReason,
            providerMetadata: r.providerMetadata,
            type: 'finish',
            usage: r.usage,
          },
        ];
        return {
          stream: new ReadableStream({
            start: (c) => {
              for (const part of parts) {
                c.enqueue(part);
              }
              c.close();
            },
          }),
        };
      }
      // A review streams as it is written.
      const admitted = await admitReview(parsed.input);
      /** Stops the review when the reader goes away without a cancel reaching the signal. */
      const dropped = new AbortController();
      const signal = options.abortSignal
        ? AbortSignal.any([options.abortSignal, dropped.signal])
        : dropped.signal;
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          cancel() {
            dropped.abort();
          },
          async start(controller) {
            /** Enqueue unless the reader has gone: a closed stream must not fail the review, which still has to settle. */
            const send = (part: LanguageModelV4StreamPart) => {
              try {
                controller.enqueue(part);
              } catch {
                dropped.abort();
              }
            };
            send({ type: 'stream-start', warnings: [] });
            send({
              modelId: REVIEWER_MODEL,
              timestamp: new Date(),
              type: 'response-metadata',
            });
            send({ id: 'review', type: 'text-start' });
            if ('paused' in admitted) {
              send({
                delta: admitted.paused,
                id: 'review',
                type: 'text-delta',
              });
              send({ id: 'review', type: 'text-end' });
              send({
                finishReason: finished,
                type: 'finish',
                usage: usageOf(0, 0),
              });
              controller.close();
              return;
            }
            try {
              // Every part is charged, finished or not: `reviewWithin`
              // settles with what reported and what the rest plausibly used.
              const { usage } = await reviewWithin(
                admitted.hold,
                admitted.plan,
                (delta) => send({ delta, id: 'review', type: 'text-delta' }),
                signal,
              );
              send({ id: 'review', type: 'text-end' });
              send({
                finishReason: finished,
                providerMetadata: reviewMetadata(usage),
                type: 'finish',
                usage: usageOf(usage.inputTokens, usage.outputTokens),
              });
            } catch (err) {
              send({ error: err, type: 'error' });
            }
            try {
              controller.close();
            } catch {
              /* Already closed by the reader. */
            }
          },
        }),
      };
    },
    modelId: JEV.split('/')[1],
    provider: 'typesafe-ai',
    specificationVersion: 'v4',
    supportedUrls: {},
  };
}
