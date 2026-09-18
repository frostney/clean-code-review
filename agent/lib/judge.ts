import { experimental_evaluate as evaluate } from 'ai';

import { cached, cacheGet, cacheKey } from './cache';
import { afterImage } from './patch';
import { type Question, questionsFor } from './questions';
import { withOneRetry } from './retry';
import type {
  FileJudgment,
  ReviewFile,
  ReviewInput,
  ReviewResult,
} from './review';
import type { Answer, Answers } from './schema';
import {
  failureWasProcessed,
  JEV_FILE_ESTIMATE_USD,
  jevCostUsd,
  jevFailedCallUsd,
} from './spend';

/** Jev, TypeSafe AI's System One model, as the AI Gateway lists it. */
export const JEV = 'typesafe-ai/jev';

/**
 * Jev answers in well under a second; a call past this is stuck, not slow.
 * The limit is per attempt, which is why the SDK's own retries are off below:
 * with them on, its backoff sleeps counted against these twelve seconds, and
 * the timeout firing mid-sleep looked exactly like the caller cancelling. The
 * backoff lives in `withOneRetry` instead, between the attempts.
 */
const CALL_TIMEOUT_MS = 12_000;

/** The rows for one file, in the shape `evaluate` takes. TypeSafe's "noul" is the SDK's "boolean". */
function questionsOf(rows: Question[]) {
  return Object.fromEntries(
    rows.map((q) =>
      q.type === 'noul'
        ? [q.id, { instructions: q.ask, type: 'boolean' as const }]
        : [
            q.id,
            {
              criteria: [...q.levels],
              instructions: q.ask,
              type: 'score' as const,
            },
          ],
    ),
  );
}

/**
 * One file, one evaluation: this is the whole integration. `signal` is one
 * attempt's, the caller's cancel and that attempt's timeout together.
 */
function evaluateFile(file: ReviewFile, signal: AbortSignal) {
  return evaluate({
    abortSignal: signal,
    // One retry, ours, each attempt with its own twelve seconds.
    maxRetries: 0,
    model: JEV,
    questions: questionsOf(questionsFor(file)),
    // For a diff, Jev gets the code as it reads after the change (what a
    // reviewer would judge) and the diff itself (what the change did).
    state: file.patch
      ? {
          code_after_change: afterImage(file.content),
          diff: file.content,
          note: "Judge the code as it stands after this change. The diff shows what changed: '+' lines were added, '-' lines removed.",
          path: file.path,
        }
      : { code: file.content, path: file.path },
  });
}

/** Bump when a question's wording changes, so cached answers to the old wording expire. */
const QUESTIONS_VERSION = 3;

/** Where one file's judgment is cached. */
function judgeKey(file: ReviewFile): string {
  // The key hashes this object as JSON, in key order: reordering these
  // properties (Biome sorts them) invalidates every stored judgment at once.
  return cacheKey('judge', {
    content: file.content,
    ids: questionsFor(file).map((q) => q.id),
    patch: file.patch === true,
    path: file.path,
    v: QUESTIONS_VERSION,
  });
}

/**
 * What judging these files would be reserved at: the estimate for every file
 * the cache has no judgment for, and nothing for the rest. Cache reads only.
 * A read that fails counts as a miss, which errs towards reserving.
 */
export async function judgeEstimateUsd(files: readonly ReviewFile[]) {
  const misses = await Promise.all(
    files.map(async (f) => (await cacheGet(judgeKey(f))) === undefined),
  );
  return misses.filter(Boolean).length * JEV_FILE_ESTIMATE_USD;
}

/**
 * What a judged turn is settled at: what every file cost, the attempts that
 * failed along the way included (see `judgeFile`).
 */
export function judgeChargeUsd(judged: { cost: number; failedUsd: number }) {
  return judged.cost + judged.failedUsd;
}

/** What Jev is sent for one file, in characters, beside the questions. */
const stateChars = (file: ReviewFile) =>
  file.patch ? 2 * file.content.length : file.content.length;

/** A file Jev could not judge, and what the attempts at it plausibly cost. */
class JudgeFileError extends Error {
  readonly spentUsd: number;
  constructor(spentUsd: number, cause: unknown) {
    super(String(cause), { cause });
    this.spentUsd = spentUsd;
  }
}

/** Every file failed; `spentUsd` is what their attempts plausibly cost together. */
export class JudgeFailedError extends Error {
  readonly spentUsd: number;
  constructor(message: string, spentUsd: number) {
    super(message);
    this.spentUsd = spentUsd;
  }
}

/**
 * One file's judgment, from the cache or from Jev. `cost` is what the file
 * cost this time, a first attempt that failed before its retry succeeded
 * included. A file that could not be judged throws a `JudgeFileError` that
 * says what its attempts plausibly cost: nothing for one never sent or turned
 * away, its input for one cancelled, timed out or failed by the server.
 */
export async function judgeFile(file: ReviewFile, signal?: AbortSignal) {
  const started = performance.now();
  const key = judgeKey(file);
  let failedUsd = 0;
  const once = async (attempt: AbortSignal) => {
    if (attempt.aborted) {
      // Never sent: the retry's wait was cut short, or the caller had gone.
      throw attempt.reason;
    }
    try {
      return await evaluateFile(file, attempt);
    } catch (err) {
      failedUsd += jevFailedCallUsd(stateChars(file), {
        outputChars: 0,
        processed: failureWasProcessed(err, attempt.aborted),
        sent: true,
      });
      throw err;
    }
  };
  let got: { value: ReturnType<typeof toJudgment>; hit: boolean };
  try {
    got = await cached(key, 'jev-judgment', async () =>
      toJudgment(await withOneRetry(once, CALL_TIMEOUT_MS, signal)),
    );
  } catch (err) {
    throw new JudgeFileError(failedUsd, err);
  }
  const { value, hit } = got;
  const judgment: FileJudgment = {
    ...value.judgment,
    cached: hit,
    ms: Math.round(performance.now() - started),
  };
  return {
    cost: hit ? 0 : value.cost + failedUsd,
    judgment,
    model: value.model,
    warnings: value.warnings,
  };
}

/** One question as Jev evaluated it. */
type EvaluatedAnswer = Awaited<
  ReturnType<typeof evaluateFile>
>['answers'][string];

/** One evaluated question in the shape the page renders. */
function toAnswer(a: EvaluatedAnswer, confidence: number | undefined): Answer {
  if (a.type === 'boolean') {
    return { noul: a.probability, type: 'noul' };
  }
  if (a.type === 'score') {
    return {
      confidence,
      probabilities: a.probabilities,
      score: a.score,
      type: 'score',
    };
  }
  return {
    choice: a.choice,
    confidence,
    probabilities: a.probabilities ?? {},
    type: 'choice',
  };
}

/** Shape an evaluation into what the page renders; this is what gets cached. */
function toJudgment(result: Awaited<ReturnType<typeof evaluateFile>>) {
  const confidence =
    (
      result.providerMetadata?.typesafe as
        | { confidence?: Record<string, unknown> }
        | undefined
    )?.confidence ?? {};
  const answers: Answers = {};
  for (const [id, a] of Object.entries(result.answers)) {
    const sure = confidence[id];
    const c =
      typeof sure === 'number' && Number.isFinite(sure)
        ? Math.max(0, Math.min(1, sure))
        : undefined;
    answers[id] = toAnswer(a, c);
  }
  const judgment: FileJudgment = {
    answers,
    ms: 0,
    usage: {
      input_tokens: result.usage.inputTokens ?? 0,
      output_tokens: result.usage.outputTokens ?? 0,
    },
  };
  const cost = jevCostUsd(
    (result.providerMetadata?.gateway as { cost?: unknown } | undefined)?.cost,
    result.usage.inputTokens ?? 0,
  );
  return {
    cost,
    judgment,
    model: result.response?.modelId ?? JEV,
    warnings: result.warnings,
  };
}

/** Every file in parallel. Jev answers each in about half a second, so a whole codebase lands together. */
export async function judgeReview(input: ReviewInput, signal?: AbortSignal) {
  const settled = await Promise.allSettled(
    input.files.map((file) => judgeFile(file, signal)),
  );
  const result: ReviewResult = {
    files: {},
    model: JEV,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  let cost = 0;
  /** What the files that could not be judged plausibly cost. */
  let failedUsd = 0;
  const warnings: Awaited<ReturnType<typeof judgeFile>>['warnings'] = [];
  const errors: string[] = [];
  settled.forEach((outcome, i) => {
    const path = input.files[i].path;
    if (outcome.status === 'rejected') {
      const reason = outcome.reason;
      failedUsd += reason instanceof JudgeFileError ? reason.spentUsd : 0;
      errors.push(
        `${path}: ${String(reason instanceof JudgeFileError ? reason.cause : reason)}`,
      );
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
  if (errors.length === input.files.length && input.files.length > 0) {
    throw new JudgeFailedError(errors.join('; '), failedUsd);
  }
  return { cost, errors, failedUsd, result, warnings };
}
