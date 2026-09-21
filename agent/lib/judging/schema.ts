import { z } from 'zod';

import type { ReviewResult } from '../review/review';
import { QUESTIONS } from './questions';

/** TypeSafe's vocabulary: `noul` is the probability of "yes"; nouls carry no `confidence`. */
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
  commentLean: z.number().optional(),
  cut: z.boolean().optional(),
  ms: z.number(),
  usage: usageSchema,
  windows: z.number().optional(),
});

const resultSchema = z.object({
  files: z.record(z.string(), fileSchema),
  kind: z.literal('judged').optional(),
  model: z.string(),
  usage: usageSchema,
});

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
