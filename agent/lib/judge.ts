import { experimental_evaluate as evaluate } from "ai";
import { cached, cacheKey } from "./cache";
import { afterImage } from "./patch";
import { type Question, questionsFor } from "./questions";
import type { FileJudgment, ReviewFile, ReviewInput, ReviewResult } from "./review";
import type { Answer, Answers } from "./schema";

/** Jev, TypeSafe AI's System One model, as the AI Gateway lists it. */
export const JEV = "typesafe-ai/jev";

/** Jev answers in well under a second; a call past this is stuck, not slow. */
const CALL_TIMEOUT_MS = 12_000;

/** The rows for one file, in the shape `evaluate` takes. TypeSafe's "noul" is the SDK's "boolean". */
function questionsOf(rows: Question[]) {
  return Object.fromEntries(
    rows.map((q) =>
      q.type === "noul"
        ? [q.id, { type: "boolean" as const, instructions: q.ask }]
        : [q.id, { type: "score" as const, instructions: q.ask, criteria: [...q.levels] }],
    ),
  );
}

/** One file, one evaluation: this is the whole integration. */
function evaluateFile(file: ReviewFile, signal?: AbortSignal) {
  return evaluate({
    model: JEV,
    // For a diff, Jev gets the code as it reads after the change (what a
    // reviewer would judge) and the diff itself (what the change did).
    state: file.patch
      ? {
          path: file.path,
          code_after_change: afterImage(file.content),
          diff: file.content,
          note: "Judge the code as it stands after this change. The diff shows what changed: '+' lines were added, '-' lines removed.",
        }
      : { path: file.path, code: file.content },
    questions: questionsOf(questionsFor(file)),
    abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]) : AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
}

/** A timed-out or failed call gets exactly one more try; a cancelled one does not. */
async function withOneRetry<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError" && !(err as { cause?: unknown }).cause) throw err;
    return await call();
  }
}

/** Bump when a question's wording changes, so cached answers to the old wording expire. */
const QUESTIONS_VERSION = 3;

export async function judgeFile(file: ReviewFile, signal?: AbortSignal) {
  const started = performance.now();
  const key = cacheKey("judge", { v: QUESTIONS_VERSION, path: file.path, patch: !!file.patch, content: file.content, ids: questionsFor(file).map((q) => q.id) });
  const { value, hit } = await cached(key, "jev-judgment", async () => toJudgment(await withOneRetry(() => evaluateFile(file, signal))));
  const judgment: FileJudgment = { ...value.judgment, ms: Math.round(performance.now() - started), cached: hit };
  return { judgment, cost: hit ? 0 : value.cost, warnings: value.warnings, model: value.model };
}

/** Shape an evaluation into what the page renders; this is what gets cached. */
function toJudgment(result: Awaited<ReturnType<typeof evaluateFile>>) {
  const confidence = (result.providerMetadata?.typesafe as { confidence?: Record<string, unknown> } | undefined)?.confidence ?? {};
  const answers: Answers = {};
  for (const [id, a] of Object.entries(result.answers)) {
    const sure = confidence[id];
    const c = typeof sure === "number" && Number.isFinite(sure) ? Math.max(0, Math.min(1, sure)) : undefined;
    const answer: Answer =
      a.type === "boolean"
        ? { type: "noul", noul: a.probability }
        : a.type === "score"
          ? { type: "score", score: a.score, probabilities: a.probabilities, confidence: c }
          : { type: "choice", choice: a.choice, probabilities: a.probabilities ?? {}, confidence: c };
    answers[id] = answer;
  }
  const judgment: FileJudgment = {
    answers,
    usage: { input_tokens: result.usage.inputTokens ?? 0, output_tokens: result.usage.outputTokens ?? 0 },
    ms: 0,
  };
  const cost = Number((result.providerMetadata?.gateway as { cost?: string } | undefined)?.cost ?? 0);
  return { judgment, cost, warnings: result.warnings, model: result.response?.modelId ?? JEV };
}

/** Every file in parallel. Jev answers each in about half a second, so a whole codebase lands together. */
export async function judgeReview(input: ReviewInput, signal?: AbortSignal) {
  const settled = await Promise.allSettled(input.files.map((file) => judgeFile(file, signal)));
  const result: ReviewResult = { model: JEV, files: {}, usage: { input_tokens: 0, output_tokens: 0 } };
  let cost = 0;
  const warnings: Awaited<ReturnType<typeof judgeFile>>["warnings"] = [];
  const errors: string[] = [];
  settled.forEach((outcome, i) => {
    const path = input.files[i].path;
    if (outcome.status === "rejected") {
      errors.push(`${path}: ${String(outcome.reason)}`);
      return;
    }
    const { judgment, cost: c, warnings: w, model } = outcome.value;
    result.files[path] = judgment;
    result.usage.input_tokens += judgment.usage.input_tokens;
    result.usage.output_tokens += judgment.usage.output_tokens;
    result.model = model;
    cost += c;
    warnings.push(...w);
  });
  if (errors.length === input.files.length && input.files.length > 0) throw new Error(errors.join("; "));
  return { result, cost, warnings, errors };
}
