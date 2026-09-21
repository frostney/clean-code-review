/**
 * Jev does not chat, but eve's `model` slot takes an AI SDK language model,
 * so this adapter dispatches two turn kinds: judge (JSON result) and
 * summarize (streamed Luna review). Anything else gets a bare ack.
 *
 * The page's spend brake lives here, not in a channel or route, because this
 * is the only place that knows both what a turn will run and what it cost. A
 * refused turn is not a failure; its reply is a `pausedReply`. The MCP
 * endpoint bypasses this adapter and has its own budget.
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';

import { parseMessage, type SummarizeInput } from '../review/prompt';
import {
  emptyReviewUsage,
  planReview,
  type ReviewUsage,
  reviewEstimateUsd,
  reviewSettleUsd,
  runReview,
} from '../review/reviewer';
import { REVIEWER_MODEL } from '../review/summary';
import {
  PAGE_DAILY_BUDGET_USD,
  PAGE_HOURLY_BUDGET_USD,
  pausedReply,
} from '../spend/budgets';
import { createSpendBrake, type Hold } from '../spend/spend';
import {
  JEV,
  JudgeFailedError,
  judgeEstimateUsd,
  judgeReview,
  judgeSettleUsd,
} from './judge';

const pageSpend = createSpendBrake('page', {
  dayUsd: PAGE_DAILY_BUDGET_USD,
  hourUsd: PAGE_HOURLY_BUDGET_USD,
});

async function admit(
  estimateUsd: number,
): Promise<{ hold: Hold } | { paused: string }> {
  const admission = await pageSpend.reserve(estimateUsd);

  return admission.ok
    ? { hold: admission.hold }
    : { paused: pausedReply(admission.window, admission.resetsAt) };
}

/** Settles the hold whether the run finishes, fails or is cancelled. */
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
    await hold.settle(reviewSettleUsd(usage));
  }
}

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

/** The page reads this off `step.completed`; eve's budget reads `gateway.cost`. */
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
    // Any error other than `JudgeFailedError` is our fault and keeps the full reservation.
    if (err instanceof JudgeFailedError) {
      await admitted.hold.settle(err.spentUsd);
    }
    throw err;
  }
  await admitted.hold.settle(judgeSettleUsd(judged));
  const { result, cost, warnings, errors } = judged;

  return textResult(JSON.stringify({ kind: 'judged', ...result }), {
    // eve's per-session cost limit and the page footer read this.
    providerMetadata: {
      gateway: { cost: String(cost) },
      judge: { kind: 'judged', model: result.model },
    },
    response: { modelId: result.model, timestamp: new Date() },
    usage: usageOf(result.usage.input_tokens, result.usage.output_tokens),
    // Surfaces why a file is missing from the result in Agent Runs.
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
      // Nothing to stream to; the whole text is the result.
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
      const admitted = await admitReview(parsed.input);
      // The reader can go away without a cancel reaching `options.abortSignal`.
      const readerGone = new AbortController();
      const signal = options.abortSignal
        ? AbortSignal.any([options.abortSignal, readerGone.signal])
        : readerGone.signal;

      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          cancel() {
            readerGone.abort();
          },
          async start(controller) {
            // A closed stream must not fail the review, which still has to settle.
            const send = (part: LanguageModelV4StreamPart) => {
              try {
                controller.enqueue(part);
              } catch {
                readerGone.abort();
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
