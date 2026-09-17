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
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';

import { JEV, judgeReview } from './judge';
import { parseMessage } from './prompt';
import { type ReviewUsage, runReview } from './reviewer';
import { REVIEWER_MODEL } from './summary';

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
  const { result, cost, warnings, errors } = await judgeReview(
    input,
    options.abortSignal,
  );
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
  const { text, usage } = await runReview(
    parsed.input,
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
      const input = parsed.input;
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({
              modelId: REVIEWER_MODEL,
              timestamp: new Date(),
              type: 'response-metadata',
            });
            controller.enqueue({ id: 'review', type: 'text-start' });
            try {
              const { usage } = await runReview(
                input,
                (delta) =>
                  controller.enqueue({
                    delta,
                    id: 'review',
                    type: 'text-delta',
                  }),
                options.abortSignal,
              );
              controller.enqueue({ id: 'review', type: 'text-end' });
              controller.enqueue({
                finishReason: finished,
                providerMetadata: reviewMetadata(usage),
                type: 'finish',
                usage: usageOf(usage.inputTokens, usage.outputTokens),
              });
            } catch (err) {
              controller.enqueue({ error: err, type: 'error' });
            }
            controller.close();
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
