import { experimental_evaluate as evaluate } from 'ai';

import { cached, cacheGet, cacheKey } from '../infra/cache';
import { withOneRetry } from '../infra/retry';
import {
  cappedAt,
  type FileJudgment,
  MAX_JUDGED_CHARS,
  REVIEW_LIMITS,
  type ReviewFile,
  type ReviewInput,
  type ReviewResult,
} from '../review/review';
import {
  failureMayHaveBilled,
  jevCallEstimateUsd,
  jevCostUsd,
  jevFailedCallUsd,
} from '../spend/spend';
import { strippedText, withoutComments } from './comments';
import { afterImage, isHunkHeader } from './patch';
import { JUDGE_STATE, QUESTIONS, questionsFor, questionsOf } from './questions';
import type { Answer, Answers } from './schema';

/** AI Gateway model id. */
export const JEV = 'typesafe-ai/jev';

/** Per attempt. Jev answers in well under a second, so a call past this is stuck, not slow. */
const CALL_TIMEOUT_MS = 12_000;

function evaluateFile(file: ReviewFile, signal: AbortSignal) {
  return evaluate({
    abortSignal: signal,
    // `withOneRetry` owns retries; SDK backoff would eat the per-attempt timeout.
    maxRetries: 0,
    model: JEV,
    questions: questionsOf(questionsFor(file)),
    state: file.patch
      ? {
          ...JUDGE_STATE.patch,
          code_after_change: afterImage(file.content),
          diff: file.content,
          path: file.path,
        }
      : { ...JUDGE_STATE.whole, code: file.content, path: file.path },
  });
}

/** Bump when a question's wording changes, so cached answers to the old wording expire. */
const QUESTIONS_VERSION = 3;

/** Pass A is the file as written; pass B is the same file without its comments. */
type PassId = 'a' | 'b';

interface JudgeCall {
  /** One window of one pass, as it is sent. */
  file: ReviewFile;
  key: string;
  pass: PassId;
}

function judgeKey(file: ReviewFile, pass: PassId, window: number): string {
  // The key hashes this object as JSON, in key order: reordering these
  // properties (Biome sorts them) invalidates every stored judgment at once.
  return cacheKey('judge', {
    content: file.content,
    ids: questionsFor(file).map((q) => q.id),
    pass,
    patch: file.patch === true,
    path: file.path,
    v: QUESTIONS_VERSION,
    window,
  });
}

/** A window of the source, as a half-open span of its lines. */
interface Span {
  from: number;
  to: number;
}

/**
 * Successive windows of at most `maxCharsPerFile`, cut on line boundaries, so
 * a long file is judged to its end rather than on its opening. Both passes are
 * cut at the same lines, so window `n` of each is the same code with and
 * without its comments. `cut` reports what the window cap left unread.
 */
function windowsOf(
  lines: readonly string[],
  budget: number,
): { spans: Span[]; cut: boolean } {
  const spans: Span[] = [];
  let from = 0;

  while (
    from < lines.length &&
    spans.length < REVIEW_LIMITS.maxWindowsPerFile
  ) {
    let to = from;
    let chars = 0;

    while (to < lines.length) {
      const next = chars + lines[to].length + (to > from ? 1 : 0);

      if (to > from && next > budget) {
        break;
      }
      chars = next;
      to++;
    }
    spans.push({ from, to });
    from = to;
  }

  return { cut: from < lines.length, spans };
}

const HUNK_HEADERS = /^@@+ .*$/gm;

/**
 * Only the counts at the start of a hunk header are read; git puts the
 * enclosing function after them, and that can be any length.
 */
const MAX_HUNK_HEADER_CHARS = 200;

/** What a restored header costs a window, header and newline together. */
const HUNK_HEADER_ROOM = MAX_HUNK_HEADER_CHARS + 1;

/**
 * `afterImage` reads nothing before the first `@@`, so a window that begins
 * inside a hunk — which is any window that does not begin with a header of its
 * own — is given back the header it was cut away from.
 */
function withHunkHeader(window: string, before: string): string {
  if (isHunkHeader(window)) {
    return window;
  }
  const last = before.match(HUNK_HEADERS)?.at(-1);

  return last === undefined
    ? window
    : `${cappedAt(last, MAX_HUNK_HEADER_CHARS)}\n${window}`;
}

/** What a window may hold, leaving room for a diff's restored hunk header. */
function budgetOf(file: ReviewFile): number {
  return (
    REVIEW_LIMITS.maxCharsPerFile - (file.patch === true ? HUNK_HEADER_ROOM : 0)
  );
}

function callsOf(
  file: ReviewFile,
  pass: PassId,
  spans: readonly Span[],
  textOf: (from: number, to: number) => string,
): { calls: JudgeCall[]; truncated: boolean } {
  let truncated = false;
  const calls = spans.map(({ from, to }, i) => {
    const window = textOf(from, to);
    const whole =
      file.patch === true ? withHunkHeader(window, textOf(0, from)) : window;
    // The spans leave room for the header, but one line can be longer than a
    // whole window, so the cap is what decides.
    const content = cappedAt(whole, REVIEW_LIMITS.maxCharsPerFile);

    truncated ||= content.length < whole.length;
    const part: ReviewFile = { ...file, content };

    return { file: part, key: judgeKey(part, pass, i), pass };
  });

  return { calls, truncated };
}

interface JudgePlan {
  a: JudgeCall[];
  /** Empty when there is no second pass to make. */
  b: JudgeCall[];
  cut: boolean;
  /** The lean to record when pass B does not run: zero only if nothing was removable. */
  leanWithoutB?: number;
}

function planOf(file: ReviewFile): JudgePlan {
  const content = cappedAt(file.content, MAX_JUDGED_CHARS);
  const source = content.split('\n');
  const budget = budgetOf(file);
  const { spans, cut } = windowsOf(source, budget);
  const a = callsOf(file, 'a', spans, (from, to) =>
    source.slice(from, to).join('\n'),
  );
  // Only what was really dropped counts as a cut: a long line that still fits
  // once the header is on it was judged whole.
  const whole = {
    cut: cut || a.truncated || file.content.length > MAX_JUDGED_CHARS,
  };
  const stripped = withoutComments({ ...file, content });

  if (stripped.kind !== 'stripped') {
    return {
      a: a.calls,
      b: [],
      ...whole,
      ...(stripped.kind === 'unchanged' ? { leanWithoutB: 0 } : {}),
    };
  }
  // A window whose every line was a comment has nothing left to ask about.
  // Pass A keeps its empty windows, so an empty file still costs one call.
  const b = callsOf(file, 'b', spans, (from, to) =>
    strippedText(stripped.lines, from, to),
  ).calls.filter((call) => call.file.content.trim() !== '');

  return { a: a.calls, b, ...whole };
}

/** Both the spend estimate and the judging itself plan the same files. */
const plans = new WeakMap<ReviewFile, JudgePlan>();

export function judgePlan(file: ReviewFile): JudgePlan {
  const held = plans.get(file);

  if (held) {
    return held;
  }
  const plan = planOf(file);

  plans.set(file, plan);

  return plan;
}

/** A failed cache read counts as a miss, erring towards reserving. */
export async function judgeEstimateUsd(files: readonly ReviewFile[]) {
  const calls = files.map(judgePlan).flatMap((plan) => [...plan.a, ...plan.b]);
  const misses = await Promise.all(
    calls.map(async (call) =>
      (await cacheGet(call.key)) === undefined
        ? jevCallEstimateUsd(stateChars(call.file))
        : 0,
    ),
  );

  return misses.reduce((total, usd) => total + usd, 0);
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

/** Shared across every call for one file, since any of them may bill and fail. */
interface Spent {
  failedUsd: number;
}

async function runCall(call: JudgeCall, spent: Spent, signal?: AbortSignal) {
  const once = async (attempt: AbortSignal) => {
    if (attempt.aborted) {
      // Not sent, so not charged.
      throw attempt.reason;
    }
    try {
      return await evaluateFile(call.file, attempt);
    } catch (err) {
      spent.failedUsd += jevFailedCallUsd(stateChars(call.file), {
        mayHaveBilled: failureMayHaveBilled(err, attempt.aborted),
        outputChars: 0,
        sent: true,
      });
      throw err;
    }
  };
  const { value, hit } = await cached(call.key, 'jev-judgment', async () =>
    toJudgment(await withOneRetry(once, CALL_TIMEOUT_MS, signal)),
  );

  return { ...value, cost: hit ? 0 : value.cost, hit };
}

/** The lower score and the higher probability, so a window cannot hide a fault. */
function worse(left: Answer, right: Answer): Answer {
  if (left.type === 'noul' && right.type === 'noul') {
    return right.noul > left.noul ? right : left;
  }
  if (left.type === 'score' && right.type === 'score') {
    return right.score < left.score ? right : left;
  }

  // A choice has no order, and two answers of different types cannot be
  // ordered either; in both cases the first window's answer stands rather than
  // an arbitrary one winning.
  return left;
}

function worstOf(parts: readonly Answers[]): Answers {
  const worst: Answers = {};

  for (const part of parts) {
    for (const [id, answer] of Object.entries(part)) {
      const held = worst[id];

      worst[id] = held === undefined ? answer : worse(held, answer);
    }
  }

  return worst;
}

interface PassResult {
  answers: Answers;
  cached: boolean;
  cost: number;
  model: string;
  usage: FileJudgment['usage'];
  warnings: Awaited<ReturnType<typeof runCall>>['warnings'];
  /** Windows that answered, which is not always every window planned. */
  windows: number;
  /** False when a window failed, so this pass does not cover the whole file. */
  complete: boolean;
}

/** A window that failed is dropped; a pass fails only when every window did. */
async function runPass(
  calls: readonly JudgeCall[],
  spent: Spent,
  signal?: AbortSignal,
): Promise<PassResult> {
  const settled = await Promise.allSettled(
    calls.map((call) => runCall(call, spent, signal)),
  );
  const done = settled.flatMap((outcome) =>
    outcome.status === 'fulfilled' ? [outcome.value] : [],
  );

  if (done.length === 0) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }
  const usage = { input_tokens: 0, output_tokens: 0 };

  for (const part of done) {
    usage.input_tokens += part.judgment.usage.input_tokens;
    usage.output_tokens += part.judgment.usage.output_tokens;
  }

  return {
    answers: worstOf(done.map((part) => part.judgment.answers)),
    cached: done.length === calls.length && done.every((part) => part.hit),
    complete: done.length === calls.length,
    cost: done.reduce((total, part) => total + part.cost, 0),
    model: done[0].model,
    usage,
    warnings: done.flatMap((part) => part.warnings),
    windows: done.length,
  };
}

/** Chapter 4's questions, the only ones whose subject is the comments themselves. */
const COMMENT_QUESTION_IDS = new Set(
  QUESTIONS.filter((q) => q.group === 'comments').map((q) => q.id),
);

const VERDICT_ID = 'verdict';

/**
 * Everything about the code is answered by the pass that cannot see the
 * comments; the comment questions are answered by the pass that can. A question
 * pass B did not answer falls back to pass A.
 */
function answersOfPasses(a: Answers, b: Answers): Answers {
  const merged: Answers = { ...b };

  for (const [id, answer] of Object.entries(a)) {
    if (COMMENT_QUESTION_IDS.has(id) || merged[id] === undefined) {
      merged[id] = answer;
    }
  }

  return merged;
}

function verdictOf(answers: Answers): number | null {
  const verdict = answers[VERDICT_ID];

  return verdict?.type === 'score' ? verdict.score : null;
}

/**
 * Only a pass that covered its whole file is comparable with the other: a
 * window lost to the gateway would otherwise read as a lean. A window the
 * second pass never planned, because stripping emptied it, still counts as
 * complete — it holds no code to fault, so the lean comes out low rather than
 * wrong. A file with no second pass to make leans by zero if it had no
 * comments, and not at all if its language has no stripper.
 */
function leanForFile(
  plan: JudgePlan,
  written: PassResult,
  bare: PassResult | null,
): number | undefined {
  if (bare === null) {
    return plan.b.length === 0 ? plan.leanWithoutB : undefined;
  }
  if (!(written.complete && bare.complete)) {
    return;
  }
  const asWritten = verdictOf(written.answers);
  const stripped = verdictOf(bare.answers);

  return asWritten === null || stripped === null
    ? undefined
    : asWritten - stripped;
}

/**
 * `cost` includes failed attempts before a successful retry. Failure of pass A
 * throws `JudgeFileError` carrying what both passes spent, since pass B may
 * have succeeded and been billed; failure of pass B costs the file its lean
 * and whatever its own attempts spent.
 */
export async function judgeFile(file: ReviewFile, signal?: AbortSignal) {
  const started = performance.now();
  const plan = judgePlan(file);
  const spent: Spent = { failedUsd: 0 };
  const [a, b] = await Promise.allSettled([
    runPass(plan.a, spent, signal),
    ...(plan.b.length ? [runPass(plan.b, spent, signal)] : []),
  ]);
  const bare = b?.status === 'fulfilled' ? b.value : null;

  if (a.status === 'rejected') {
    throw new JudgeFileError(spent.failedUsd + (bare?.cost ?? 0), a.reason);
  }
  const judgment: FileJudgment = {
    answers: bare
      ? answersOfPasses(a.value.answers, bare.answers)
      : a.value.answers,
    // A failed attempt was paid for, so this is not a free answer.
    cached:
      spent.failedUsd === 0 && a.value.cached && (bare === null || bare.cached),
    ms: Math.round(performance.now() - started),
    usage: {
      input_tokens:
        a.value.usage.input_tokens + (bare?.usage.input_tokens ?? 0),
      output_tokens:
        a.value.usage.output_tokens + (bare?.usage.output_tokens ?? 0),
    },
    windows: a.value.windows,
    ...(plan.cut ? { cut: true } : {}),
  };
  const lean = leanForFile(plan, a.value, bare);

  if (lean !== undefined) {
    judgment.commentLean = lean;
  }

  return {
    cost: a.value.cost + (bare?.cost ?? 0) + spent.failedUsd,
    judgment,
    model: a.value.model,
    warnings: [...a.value.warnings, ...(bare?.warnings ?? [])],
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
