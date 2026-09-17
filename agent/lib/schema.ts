import { z } from 'zod';

import { QUESTIONS } from './questions';
import type { ReviewResult } from './review';

/**
 * What the meters render, in TypeSafe's own answer vocabulary: a noul carries
 * the probability of "yes", a score its position on the levels (with the
 * distribution behind it), a choice the winner plus a probability per option.
 * `confidence` is TypeSafe's per-question certainty for scores and choices;
 * nouls do not carry one.
 */
export type Answer =
  | { type: 'noul'; noul: number }
  | {
      type: 'score';
      score: number;
      probabilities?: Record<string, number>;
      confidence?: number;
    }
  | {
      type: 'choice';
      choice: string;
      probabilities: Record<string, number>;
      confidence?: number;
    };

export type Answers = Record<string, Answer>;

const probability = z.number().min(0).max(1);
const distribution = z.record(z.string(), z.number());

const answerSchema = z.discriminatedUnion('type', [
  z.object({ noul: probability, type: z.literal('noul') }),
  z.object({
    confidence: probability.optional(),
    probabilities: distribution.optional(),
    score: z.number(),
    type: z.literal('score'),
  }),
  z.object({
    choice: z.string(),
    confidence: probability.optional(),
    probabilities: distribution,
    type: z.literal('choice'),
  }),
]);

const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
});

const fileSchema = z.object({
  // Rows are validated one by one below, so one odd answer cannot sink the rest.
  answers: z.record(z.string(), z.unknown()),
  cached: z.boolean().optional(),
  ms: z.number(),
  usage: usageSchema,
});

const resultSchema = z.object({
  files: z.record(z.string(), fileSchema),
  kind: z.literal('judged').optional(),
  model: z.string(),
  usage: usageSchema,
});

/** Keep the answers that match their question; drop the rest quietly. */
function validAnswers(raw: Record<string, unknown>): Answers {
  const answers: Answers = {};
  for (const q of QUESTIONS) {
    const row = answerSchema.safeParse(raw[q.id]);
    if (!row.success) {
      continue;
    }
    const a = row.data;
    if (a.type !== q.type) {
      continue;
    }
    answers[q.id] = a;
  }
  return answers;
}

/** Read the assistant's text as a review result. Null when it is not one. */
export function parseReview(
  text: string | null | undefined,
): ReviewResult | null {
  if (!text) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const files: ReviewResult['files'] = {};
  for (const [path, file] of Object.entries(parsed.data.files)) {
    files[path] = { ...file, answers: validAnswers(file.answers) };
  }
  return { ...parsed.data, files };
}
