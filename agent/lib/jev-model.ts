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
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { JEV, judgeReview } from "./judge";
import { parseMessage } from "./prompt";
import { runReview, type ReviewUsage } from "./reviewer";
import { REVIEWER_MODEL } from "./summary";

function lastUserText(options: LanguageModelV4CallOptions): string {
  const last = [...options.prompt].reverse().find((m) => m.role === "user");
  return last?.role === "user" ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("\n") : "";
}

const tokens = (n: number) => ({ total: n, noCache: n, cacheRead: undefined, cacheWrite: undefined });
const usageOf = (input: number, output: number): LanguageModelV4Usage => ({
  inputTokens: tokens(input),
  outputTokens: { total: output, text: output, reasoning: undefined },
});
const finished = { unified: "stop" as const, raw: "stop" };

/** Metadata the page reads off `step.completed`: the gateway's cost for eve's budget, and what the review was. */
function reviewMetadata(usage: ReviewUsage) {
  return { gateway: { cost: String(usage.costUsd) }, judge: { kind: "summary", model: REVIEWER_MODEL, cached: usage.cached } };
}

function textResult(text: string, extra: Partial<LanguageModelV4GenerateResult> = {}): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: finished,
    usage: usageOf(0, 0),
    warnings: [],
    response: { modelId: JEV, timestamp: new Date() },
    ...extra,
  };
}

async function judge(options: LanguageModelV4CallOptions, input: Parameters<typeof judgeReview>[0]): Promise<LanguageModelV4GenerateResult> {
  const { result, cost, warnings, errors } = await judgeReview(input, options.abortSignal);
  return textResult(JSON.stringify({ kind: "judged", ...result }), {
    usage: usageOf(result.usage.input_tokens, result.usage.output_tokens),
    // eve's per-session cost limit and the page footer read the gateway's cost from here.
    providerMetadata: { gateway: { cost: String(cost) }, judge: { kind: "judged", model: result.model } },
    // A file Jev could not judge is absent from the result; say why in the
    // step's warnings so Agent Runs shows it.
    warnings: [...warnings, ...errors.map((message) => ({ type: "other" as const, message }))],
    response: { modelId: result.model, timestamp: new Date() },
  });
}

async function generate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
  const parsed = parseMessage(lastUserText(options));
  if (parsed.kind === "other") return textResult(JSON.stringify({ kind: "ack" }));
  if (parsed.kind === "judge") return judge(options, parsed.input);
  const { text, usage } = await runReview(parsed.input, () => {}, options.abortSignal);
  return textResult(text, {
    usage: usageOf(usage.inputTokens, usage.outputTokens),
    providerMetadata: reviewMetadata(usage),
    response: { modelId: REVIEWER_MODEL, timestamp: new Date() },
  });
}

export function jev(): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "typesafe-ai",
    modelId: JEV.split("/")[1],
    supportedUrls: {},
    doGenerate: generate,
    async doStream(options) {
      const parsed = parseMessage(lastUserText(options));
      if (parsed.kind !== "summarize") {
        // Judge turns and acknowledgements arrive whole.
        const r = await generate(options);
        const text = r.content[0]?.type === "text" ? r.content[0].text : "";
        const parts: LanguageModelV4StreamPart[] = [
          { type: "stream-start", warnings: r.warnings },
          { type: "response-metadata", ...r.response },
          { type: "text-start", id: "jev" },
          { type: "text-delta", id: "jev", delta: text },
          { type: "text-end", id: "jev" },
          { type: "finish", usage: r.usage, finishReason: r.finishReason, providerMetadata: r.providerMetadata },
        ];
        return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
      }
      // A review streams as it is written.
      const input = parsed.input;
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "response-metadata", modelId: REVIEWER_MODEL, timestamp: new Date() });
            controller.enqueue({ type: "text-start", id: "review" });
            try {
              const { usage } = await runReview(input, (delta) => controller.enqueue({ type: "text-delta", id: "review", delta }), options.abortSignal);
              controller.enqueue({ type: "text-end", id: "review" });
              controller.enqueue({ type: "finish", usage: usageOf(usage.inputTokens, usage.outputTokens), finishReason: finished, providerMetadata: reviewMetadata(usage) });
            } catch (err) {
              controller.enqueue({ type: "error", error: err });
            }
            controller.close();
          },
        }),
      };
    },
  };
}
