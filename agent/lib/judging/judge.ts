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
  /** Its place in the file; pass B skips a window stripping emptied. */
  window: number;
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

    return { file: part, key: judgeKey(part, pass, i), pass, window: i };
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
  /** How many were still being judged when the signal stopped judging. */
  readonly stopped: number;
  constructor(message: string, spentUsd: number, stopped = 0) {
    super(message);
    this.spentUsd = spentUsd;
    this.stopped = stopped;
  }
}

/**
 * Jev calls one review keeps in flight. Measured on four large pull requests
 * (33 to 66 calls each, eight runs per setting, 2026-09-23): uncapped, 11.0%
 * of calls were still lost after their retry and the judging took 1.9 s; at
 * 16, 8.6% and 2.7 s; at 8, 6.1% and 3.7 s; at 4, 8.0% and 6.2 s. The gateway
 * answers 503 more often the more a caller has in flight, but most of all the
 * longer the window, which no cap changes; 8 is where the loss bottomed out.
 */
const MAX_JEV_CALLS_IN_FLIGHT = 8;

/**
 * Past this a review stops asking and returns what answered; the rest is
 * reported as partly judged or unjudged, which the reader can ask again. A
 * 66-call review took at most 6.2 s at the cap, but a stalled gateway queued
 * behind it could hold one for minutes: each attempt's 12 s timeout starts
 * only when it gets a slot.
 */
const MAX_JUDGING_MS = 60_000;

type Slots = <T>(work: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

/** At most `max` pieces of work at once; the rest start in the order they asked. */
function slotsOf(max: number): Slots {
  let free = max;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();

    if (next) {
      next();
    } else {
      free++;
    }
  };
  const turn = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);

        return;
      }
      const go = () => {
        signal?.removeEventListener('abort', stop);
        resolve();
      };

      function stop() {
        waiting.splice(waiting.indexOf(go), 1);
        reject(signal?.reason);
      }

      waiting.push(go);
      signal?.addEventListener('abort', stop, { once: true });
    });

  return async (work, signal) => {
    if (free > 0) {
      free--;
    } else {
      await turn(signal);
    }
    try {
      return await work();
    } finally {
      release();
    }
  };
}

/** Shared across every call for one file, since any of them may bill and fail. */
interface Spent {
  failedUsd: number;
}

/**
 * A cached answer takes no slot. A call keeps its slot through its retry, so
 * a burst of 503s is not answered with a burst of retries.
 */
async function runCall(
  call: JudgeCall,
  spent: Spent,
  slots: Slots,
  signal?: AbortSignal,
) {
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
    toJudgment(
      await slots(() => withOneRetry(once, CALL_TIMEOUT_MS, signal), signal),
    ),
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
  /** By window, for the windows that answered. */
  answers: Map<number, Answers>;
  cached: boolean;
  cost: number;
  model: string;
  usage: FileJudgment['usage'];
  warnings: Awaited<ReturnType<typeof runCall>>['warnings'];
  /** False when a window failed, so this pass does not cover the whole file. */
  complete: boolean;
}

/** A window that failed is dropped; a pass fails only when every window did. */
async function runPass(
  calls: readonly JudgeCall[],
  spent: Spent,
  slots: Slots,
  signal?: AbortSignal,
): Promise<PassResult> {
  const settled = await Promise.allSettled(
    calls.map((call) => runCall(call, spent, slots, signal)),
  );
  const done = settled.flatMap((outcome, i) =>
    outcome.status === 'fulfilled'
      ? [{ ...outcome.value, window: calls[i].window }]
      : [],
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
    answers: new Map(done.map((part) => [part.window, part.judgment.answers])),
    cached: done.length === calls.length && done.every((part) => part.hit),
    complete: done.length === calls.length,
    cost: done.reduce((total, part) => total + part.cost, 0),
    model: done[0].model,
    usage,
    warnings: done.flatMap((part) => part.warnings),
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

function only(answers: Answers, keep: (id: string) => boolean): Answers {
  return Object.fromEntries(Object.entries(answers).filter(([id]) => keep(id)));
}

const isCommentQuestion = (id: string) => COMMENT_QUESTION_IDS.has(id);

/**
 * Window by window, as `answersOfPasses` merges whole passes, then the worst
 * over the windows. A window whose reading without comments was lost falls
 * back to the reading with them, which saw the same code; one that reading
 * lost gives only its code answers. A window stripping emptied holds nothing
 * but comments, so only the comment questions are asked of it.
 */
function answersOfWindows(
  plan: JudgePlan,
  written: PassResult,
  bare: PassResult | null,
): Answers {
  const strippable = new Set(plan.b.map((call) => call.window));
  const windows: Answers[] = [];

  for (let window = 0; window < plan.a.length; window++) {
    const a = written.answers.get(window);
    const b = bare?.answers.get(window);

    if (a && b) {
      windows.push(answersOfPasses(a, b));
    } else if (b) {
      windows.push(only(b, (id) => !isCommentQuestion(id)));
    } else if (a) {
      const onlyComments = plan.b.length > 0 && !strippable.has(window);

      windows.push(onlyComments ? only(a, isCommentQuestion) : a);
    }
  }

  return worstOf(windows);
}

/** Windows only the reading without comments answered, so no comment question covers them. */
function strippedOnly(written: PassResult, bare: PassResult | null): number {
  return [...(bare?.answers.keys() ?? [])].filter(
    (window) => !written.answers.has(window),
  ).length;
}

/** A window read as written whose reading without comments did not answer. */
function strippedMissing(
  plan: JudgePlan,
  written: PassResult,
  bare: PassResult | null,
): boolean {
  return plan.b.some(
    (call) =>
      written.answers.has(call.window) && !bare?.answers.has(call.window),
  );
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
  const asWritten = verdictOf(worstOf([...written.answers.values()]));
  const stripped = verdictOf(worstOf([...bare.answers.values()]));

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
export async function judgeFile(
  file: ReviewFile,
  signal?: AbortSignal,
  slots: Slots = slotsOf(MAX_JEV_CALLS_IN_FLIGHT),
) {
  const started = performance.now();
  const plan = judgePlan(file);
  const spent: Spent = { failedUsd: 0 };
  const [a, b] = await Promise.allSettled([
    runPass(plan.a, spent, slots, signal),
    ...(plan.b.length ? [runPass(plan.b, spent, slots, signal)] : []),
  ]);
  const bare = b?.status === 'fulfilled' ? b.value : null;

  if (a.status === 'rejected') {
    throw new JudgeFileError(spent.failedUsd + (bare?.cost ?? 0), a.reason);
  }
  const readOnlyBare = strippedOnly(a.value, bare);
  const judgment: FileJudgment = {
    answers: answersOfWindows(plan, a.value, bare),
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
    windows: a.value.answers.size,
    windowsPlanned: plan.a.length,
    ...(readOnlyBare ? { strippedOnly: readOnlyBare } : {}),
    ...(plan.cut ? { cut: true } : {}),
    ...(strippedMissing(plan, a.value, bare) ? { strippedMissing: true } : {}),
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
  const slots = slotsOf(MAX_JEV_CALLS_IN_FLIGHT);
  const ceiling = AbortSignal.timeout(MAX_JUDGING_MS);
  const within = signal ? AbortSignal.any([signal, ceiling]) : ceiling;
  // A file that failed only once judging was stopped failed because of it; one
  // that failed before then failed on its own.
  const endedStopped: boolean[] = [];
  const settled = await Promise.allSettled(
    input.files.map(async (file, i) => {
      try {
        return await judgeFile(file, within, slots);
      } finally {
        endedStopped[i] = within.aborted;
      }
    }),
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
  /** Files with no answer because judging was stopped before they had one. */
  const stopped: string[] = [];

  settled.forEach((outcome, i) => {
    const path = input.files[i].path;

    if (outcome.status === 'rejected') {
      const reason = outcome.reason;

      if (endedStopped[i]) {
        stopped.push(path);
      }
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
    throw new JudgeFailedError(errors.join('; '), failedUsd, stopped.length);
  }

  return { cost, errors, failedUsd, result, stopped, warnings };
}
