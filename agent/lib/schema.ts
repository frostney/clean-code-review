import { z } from "zod";
import { QUESTIONS } from "./questions";
import type { ReviewResult } from "./review";

/**
 * What the meters render, in TypeSafe's own answer vocabulary: a noul carries
 * the probability of "yes", a score its position on the levels (with the
 * distribution behind it), a choice the winner plus a probability per option.
 * `confidence` is TypeSafe's per-question certainty for scores and choices;
 * nouls do not carry one.
 */
export type Answer =
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; probabilities?: Record<string, number>; confidence?: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number };

export type Answers = Record<string, Answer>;

const probability = z.number().min(0).max(1);
const distribution = z.record(z.string(), z.number());

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({ type: z.literal("score"), score: z.number(), probabilities: distribution.optional(), confidence: probability.optional() }),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: distribution, confidence: probability.optional() }),
]);

const usageSchema = z.object({ input_tokens: z.number(), output_tokens: z.number() });

const fileSchema = z.object({
  // Rows are validated one by one below, so one odd answer cannot sink the rest.
  answers: z.record(z.string(), z.unknown()),
  usage: usageSchema,
  ms: z.number(),
  cached: z.boolean().optional(),
});

const resultSchema = z.object({
  kind: z.literal("judged").optional(),
  model: z.string(),
  files: z.record(z.string(), fileSchema),
  usage: usageSchema,
});

/** Keep the answers that match their question; drop the rest quietly. */
export function validAnswers(raw: Record<string, unknown>): Answers {
  const answers: Answers = {};
  for (const q of QUESTIONS) {
    const row = answerSchema.safeParse(raw[q.id]);
    if (!row.success) continue;
    const a = row.data;
    if (a.type !== q.type) continue;
    answers[q.id] = a;
  }
  return answers;
}

/** Read the assistant's text as a review result. Null when it is not one. */
export function parseReview(text: string | null | undefined): ReviewResult | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return null;
  const files: ReviewResult["files"] = {};
  for (const [path, file] of Object.entries(parsed.data.files)) {
    files[path] = { ...file, answers: validAnswers(file.answers) };
  }
  return { ...parsed.data, files };
}
