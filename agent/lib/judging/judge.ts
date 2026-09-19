import { experimental_evaluate as evaluate } from 'ai';

import { cached, cacheGet, cacheKey } from '../infra/cache';
import { withOneRetry } from '../infra/retry';
import type {
  FileJudgment,
  ReviewFile,
  ReviewInput,
  ReviewResult,
} from '../review/review';
import {
  failureMayHaveBilled,
  JEV_FILE_ESTIMATE_USD,
  jevCostUsd,
  jevFailedCallUsd,
} from '../spend/spend';
import { afterImage } from './patch';
import { type Question, questionsFor } from './questions';
import type { Answer, Answers } from './schema';

/** AI Gateway model id. */
export const JEV = 'typesafe-ai/jev';

/** Per attempt. Jev answers in well under a second, so a call past this is stuck, not slow. */
const CALL_TIMEOUT_MS = 12_000;

/** TypeSafe's "noul" is the SDK's "boolean". */
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

function evaluateFile(file: ReviewFile, signal: AbortSignal) {
  return evaluate({
    abortSignal: signal,
    // `withOneRetry` owns retries; SDK backoff would eat the per-attempt timeout.
    maxRetries: 0,
    model: JEV,
    questions: questionsOf(questionsFor(file)),
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

/** A failed cache read counts as a miss, erring towards reserving. */
export async function judgeEstimateUsd(files: readonly ReviewFile[]) {
  const misses = await Promise.all(
    files.map(async (f) => (await cacheGet(judgeKey(f))) === undefined),
  );
  return misses.filter(Boolean).length * JEV_FILE_ESTIMATE_USD;
}

export function judgeSettleUsd(judged: { cost: number; failedUsd: number }) {
  return judged.cost + judged.failedUsd;
}

/** A diff sends both the after-image and the diff, so roughly twice the content. */
const stateChars = (file: ReviewFile) =>
  file.patch ? 2 * file.content.length : file.content.length;

class JudgeFileError extends Error {
  readonly spentUsd: number;
  constructor(spentUsd: number, cause: unknown) {
    super(String(cause), { cause });
    this.spentUsd = spentUsd;
  }
}

/** Thrown only when every file failed. */
export class JudgeFailedError extends Error {
  readonly spentUsd: number;
  constructor(message: string, spentUsd: number) {
    super(message);
    this.spentUsd = spentUsd;
  }
}

/**
 * `cost` includes a failed first attempt before a successful retry. Failure
 * throws `JudgeFileError` carrying the attempts' estimated cost.
 */
export async function judgeFile(file: ReviewFile, signal?: AbortSignal) {
  const started = performance.now();
  const key = judgeKey(file);
  let failedUsd = 0;
  const once = async (attempt: AbortSignal) => {
    if (attempt.aborted) {
      // Not sent, so not charged.
      throw attempt.reason;
    }
    try {
      return await evaluateFile(file, attempt);
    } catch (err) {
      failedUsd += jevFailedCallUsd(stateChars(file), {
        mayHaveBilled: failureMayHaveBilled(err, attempt.aborted),
        outputChars: 0,
        sent: true,
      });
      throw err;
    }
  };
  let lookup: { value: ReturnType<typeof toJudgment>; hit: boolean };
  try {
    lookup = await cached(key, 'jev-judgment', async () =>
      toJudgment(await withOneRetry(once, CALL_TIMEOUT_MS, signal)),
    );
  } catch (err) {
    throw new JudgeFileError(failedUsd, err);
  }
  const { value, hit } = lookup;
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

type EvaluatedAnswer = Awaited<
  ReturnType<typeof evaluateFile>
>['answers'][string];

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

/** The return value is what gets cached. */
function toJudgment(result: Awaited<ReturnType<typeof evaluateFile>>) {
  const confidence =
    (
      result.providerMetadata?.typesafe as
        | { confidence?: Record<string, unknown> }
        | undefined
    )?.confidence ?? {};
  const answers: Answers = {};
  for (const [id, a] of Object.entries(result.answers)) {
    const reported = confidence[id];
    const clamped =
      typeof reported === 'number' && Number.isFinite(reported)
        ? Math.max(0, Math.min(1, reported))
        : undefined;
    answers[id] = toAnswer(a, clamped);
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

/** Throws `JudgeFailedError` only when every file fails; otherwise failures are listed in `errors`. */
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
