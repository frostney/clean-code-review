/**
 * Luna writes the prose review from Jev's findings, one model call per part
 * (an overall part, then file batches), all started at once but streamed in
 * fixed order so the combined text is always a well-formed review.
 *
 * Only parts that finished on their own are cached; a part cut off twice is
 * shown as far as it got and marked incomplete.
 *
 * File parts read untrusted code, so their output is filtered: lines shaped
 * like adapter signal lines are dropped (`withoutSignalLines`), as are
 * sections the part was not asked for (`onlyOwnSections`).
 */
import { streamText } from 'ai';

import { cacheGet, cacheKey, cacheSet } from '../infra/cache';
import { questionById, SMELL_IDS } from '../judging/questions';
import {
  failureMayHaveBilled,
  lunaCostUsd,
  lunaFailedCallUsd,
  lunaPartEstimateUsd,
} from '../spend/spend';
import type { SummarizeInput } from './prompt';
import { REVIEWER_INSTRUCTIONS } from './reviewer-prompt';
import {
  cutOffLine,
  OVERALL_REWRITE_LINE,
  OVERALL_SECTION,
  onlyOwnSections,
  ownsSection,
  parseSummaryText,
  REVIEW_BATCH_SIZE,
  REVIEWER_MODEL,
  type ReviewPart,
  withoutSignalLines,
} from './summary';

/** Bump when the reviewer's instructions or output handling change, so cached parts expire. */
const REVIEW_VERSION = 11;

/** The findings cover the rest of the file. */
const FILE_EXCERPT_CHARS = 8_000;

const PR_BODY_CHARS = 2_000;

/**
 * A safety net against untrusted code keeping the model writing, not a
 * length control (the prompt owns that); reasoning counts against it.
 * Measured peaks were 816 tokens for a 6-file batch and 183 for overall, so
 * these sit 5x and 10x above.
 */
const MAX_OUTPUT_TOKENS: Record<ReviewPart['role'], number> = {
  files: 4000,
  overall: 2000,
};

const RETRY_CEILING_FACTOR = 2;

/**
 * Bounds a reviewer that stops answering, so the summary run fails and the
 * overall block shows the quiet "No review:" line with the reason, instead
 * of the page waiting on a stream that will not end. Measured parts reached
 * their first chunk in 3.3 to 5.0 s and streamed for 0.5 to 2.9 s more, so
 * `firstChunkMs` sits 4x above the slowest start and `chunkMs` 3x above the
 * longest whole stream. A reasoning delta with text in it resets the chunk
 * timer, so a model that thinks before it answers is not cut off.
 *
 * `streamRetries` stays at its default of none: deltas go straight to the
 * page, so a restarted stream would repeat a section already on screen.
 */
export const REVIEWER_TIMEOUT = {
  chunkMs: 10_000,
  firstChunkMs: 20_000,
};

/**
 * Reasons for that "No review:" line, which takes them lower case and
 * without advice (`plainReason` in `src/review/errors.ts`). The SDK names
 * the bound that fired nowhere but in its abort reason's prose, so the match
 * is loose and the reason itself goes to the log rather than to the reader.
 */
export const TIMED_OUT = {
  chunk: 'the reviewer stopped part-way through its answer',
  firstChunk: 'the reviewer did not start answering',
  total: 'the reviewer took too long',
};

function timedOut(reason: unknown): string {
  const text = String(reason);
  console.warn(`[review] A reviewer call was stopped by its bound: ${text}`);
  if (/first chunk/i.test(text)) {
    return TIMED_OUT.firstChunk;
  }
  return /chunk/i.test(text) ? TIMED_OUT.chunk : TIMED_OUT.total;
}

/**
 * A third below the slowest throughput measured (about 75 output tokens a
 * second), so the wall-clock cap it sizes is out of reach of an attempt
 * writing to its ceiling and can only be hit by a stream that drips.
 */
const MS_PER_OUTPUT_TOKEN = 20;

/** Jev's yes/no answers are probabilities; at or above this, the smell is a finding. */
const EVEN_ODDS = 0.5;

/** Index of the top level on the five-level score scale. */
const TOP_LEVEL = 4;

const OVERALL_FINDINGS = 5;

function reviewerMessage(
  input: SummarizeInput,
  mode: ReviewPart['role'],
): string {
  const files = input.files.map((file) => {
    const answers = input.judgments[file.path] ?? {};
    const findings = SMELL_IDS.filter(
      (id) =>
        answers[id]?.type === 'noul' &&
        (answers[id] as { noul: number }).noul >= EVEN_ODDS,
    )
      .map((id) => ({
        probability: (answers[id] as { noul: number }).noul,
        smell: questionById(id)?.label ?? id,
      }))
      .sort((a, b) => b.probability - a.probability);
    const scales = Object.fromEntries(
      Object.entries(answers)
        .filter(([, a]) => a.type === 'score')
        .map(([id, a]) => {
          const q = questionById(id);
          const sc = (a as { score: number }).score;
          return [
            q?.label ?? id,
            q?.type === 'score'
              ? q.levels[Math.max(0, Math.min(TOP_LEVEL, Math.round(sc)))]
              : sc,
          ];
        }),
    );
    if (mode === 'overall') {
      return {
        findings: findings.slice(0, OVERALL_FINDINGS),
        kind: file.patch ? 'diff' : 'file',
        path: file.path,
        scales,
      };
    }
    const code =
      file.content.length > FILE_EXCERPT_CHARS
        ? `${file.content.slice(0, FILE_EXCERPT_CHARS)}\n… (truncated)`
        : file.content;
    return {
      code,
      findings,
      kind: file.patch ? 'diff' : 'file',
      path: file.path,
      scales,
    };
  });
  return JSON.stringify({
    mode,
    ...(mode === 'overall' && input.pr
      ? { body: input.pr.body?.slice(0, PR_BODY_CHARS), title: input.pr.title }
      : {}),
    files,
  });
}

interface PlannedPart {
  part: ReviewPart;
  message: string;
  key: string;
}

interface PlanEntry extends PlannedPart {
  hit: string | null;
}

export interface ReviewPlan {
  parts: PlanEntry[];
}

/** Overall first; the stream order depends on it. */
function planParts(input: SummarizeInput): PlannedPart[] {
  const parts: PlannedPart[] = [];
  const overall = {
    index: 0,
    paths: input.files.map((f) => f.path),
    role: 'overall' as const,
  };
  const overallMessage = reviewerMessage(input, 'overall');
  parts.push({
    // Key order is part of the key: see the note in judge.ts.
    key: cacheKey('review-part', {
      message: overallMessage,
      model: REVIEWER_MODEL,
      v: REVIEW_VERSION,
    }),
    message: overallMessage,
    part: overall,
  });
  for (let i = 0; i * REVIEW_BATCH_SIZE < input.files.length; i++) {
    const files = input.files.slice(
      i * REVIEW_BATCH_SIZE,
      (i + 1) * REVIEW_BATCH_SIZE,
    );
    const message = reviewerMessage({ ...input, files }, 'files');
    parts.push({
      key: cacheKey('review-part', {
        message,
        model: REVIEWER_MODEL,
        v: REVIEW_VERSION,
      }),
      message,
      part: { index: i, paths: files.map((f) => f.path), role: 'files' },
    });
  }
  return parts;
}

export async function planReview(input: SummarizeInput): Promise<ReviewPlan> {
  const parts = await Promise.all(
    planParts(input).map(async (p) => ({
      ...p,
      hit: (await cacheGet<string>(p.key)) || null,
    })),
  );
  return { parts };
}

const promptChars = (p: PlannedPart) =>
  p.message.length + REVIEWER_INSTRUCTIONS.length;

function attemptEstimateUsd(p: PlannedPart, ceiling: number): number {
  return lunaPartEstimateUsd(promptChars(p), ceiling);
}

/** Covers one attempt per uncached part; a ceiling retry is not reserved. */
export function reviewEstimateUsd(plan: ReviewPlan): number {
  return plan.parts
    .filter((p) => p.hit === null)
    .reduce(
      (total, p) =>
        total + attemptEstimateUsd(p, MAX_OUTPUT_TOKENS[p.part.role]),
      0,
    );
}

export interface ReviewUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Estimated cost of attempts that failed or were cancelled before reporting. */
  unreportedUsd: number;
  cached: boolean;
}

export function emptyReviewUsage(): ReviewUsage {
  return {
    cached: true,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    unreportedUsd: 0,
  };
}

export function reviewSettleUsd(usage: ReviewUsage): number {
  return usage.costUsd + usage.unreportedUsd;
}

/**
 * Abort reason for sibling parts when one fails. They hit the same gateway at
 * the same moment, so a stopped sibling is charged as the failed one was:
 * nothing if it was turned away, its prompt otherwise.
 */
class PartFailed extends Error {
  readonly mayHaveBilled: boolean;
  constructor(cause: unknown, mayHaveBilled: boolean) {
    super('another part of the review failed', { cause });
    this.mayHaveBilled = mayHaveBilled;
  }
}

/** `seen` counts answer and reasoning characters. Failure and cancellation arrive as stream parts and are thrown. */
async function readParts(
  parts: AsyncIterable<{
    type: string;
    text?: string;
    error?: unknown;
    reason?: unknown;
  }>,
  text: ReturnType<typeof withoutSignalLines>,
  seen: { chars: number },
  signal: AbortSignal,
): Promise<void> {
  for await (const part of parts) {
    if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
      const delta = part.text ?? '';
      seen.chars += delta.length;
      if (part.type === 'text-delta') {
        text.write(delta);
      }
    } else if (part.type === 'error') {
      throw part.error;
    } else if (part.type === 'abort') {
      signal.throwIfAborted();
      // Past `throwIfAborted` the only signal left is one of this call's own
      // bounds, so the message is written for the reader, not from the cause.
      throw new Error(
        part.reason === undefined
          ? 'the model call was aborted'
          : timedOut(part.reason),
      );
    }
  }
  text.end();
}

/**
 * Resolves with the finish reason. An already-aborted signal means nothing is
 * sent or charged; a failed attempt adds its estimated cost and rethrows.
 */
async function attempt(
  p: PlannedPart,
  ceiling: number,
  push: (delta: string) => void,
  usage: ReviewUsage,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const stream = streamText({
    abortSignal: signal,
    maxOutputTokens: ceiling,
    model: REVIEWER_MODEL,
    prompt: p.message,
    system: REVIEWER_INSTRUCTIONS,
    timeout: {
      ...REVIEWER_TIMEOUT,
      // The longest start allowed plus the longest this ceiling could take to
      // write: a cap no healthy attempt can reach.
      totalMs: REVIEWER_TIMEOUT.firstChunkMs + ceiling * MS_PER_OUTPUT_TOKEN,
    },
  });
  const sections = onlyOwnSections(push, p.part);
  const signals = withoutSignalLines(sections.write);
  const text = {
    end() {
      signals.end();
      sections.end();
    },
    write: signals.write,
  };
  const seen = { chars: 0 };
  try {
    await readParts(stream.stream, text, seen, signal);
    const [finishReason, u, meta] = await Promise.all([
      stream.finishReason,
      stream.usage,
      stream.providerMetadata,
    ]);
    const input = u?.inputTokens ?? 0;
    const output = u?.outputTokens ?? 0;
    usage.inputTokens += input;
    usage.outputTokens += output;
    usage.costUsd += lunaCostUsd(
      (meta?.gateway as { cost?: unknown } | undefined)?.cost,
      input,
      output,
    );
    return finishReason;
  } catch (err) {
    const stoppedFor = signal.aborted ? signal.reason : undefined;
    usage.unreportedUsd += lunaFailedCallUsd(promptChars(p), {
      mayHaveBilled:
        stoppedFor instanceof PartFailed
          ? stoppedFor.mayHaveBilled
          : failureMayHaveBilled(err, signal.aborted),
      outputChars: seen.chars,
      sent: true,
    });
    throw err;
  }
}

function lastSection(text: string): string | null {
  const parsed = parseSummaryText(text);
  return parsed.files.at(-1)?.path ?? (parsed.overall ? OVERALL_SECTION : null);
}

/**
 * Retries once with a larger ceiling if cut off. Resolves true when the part
 * may be cached. A part cut off twice ends with a `cutOffLine` for the
 * section it stopped in and each it never reached.
 */
async function writePart(
  p: PlannedPart,
  push: (delta: string) => void,
  usage: ReviewUsage,
  signal: AbortSignal,
): Promise<boolean> {
  const ceiling = MAX_OUTPUT_TOKENS[p.part.role];
  let finish = await attempt(p, ceiling, push, usage, signal);
  if (finish !== 'length') {
    return finish === 'stop';
  }
  // Ends whatever line the cut left open. The overall part's first try is
  // dropped outright; a file section written again replaces its first try.
  push(p.part.role === 'overall' ? `\n${OVERALL_REWRITE_LINE}\n` : '\n');
  let own = '';
  finish = await attempt(
    p,
    ceiling * RETRY_CEILING_FACTOR,
    (delta) => {
      own += delta;
      push(delta);
    },
    usage,
    signal,
  );
  if (finish !== 'length') {
    return finish === 'stop';
  }
  const stopped = lastSection(own);
  const written = new Set(parseSummaryText(own).files.map((f) => f.path));
  const unreached =
    p.part.role === 'files'
      ? p.part.paths.filter((path) => !written.has(path))
      : [];
  const cut = [
    ...(stopped === null ? [] : [stopped]),
    ...unreached,
    ...(p.part.role === 'overall' && stopped === null ? [OVERALL_SECTION] : []),
  ];
  push(`\n${cut.map(cutOffLine).join('\n')}\n`);
  return false;
}

interface StartedPart {
  kind: 'run';
  p: PlanEntry;
  /** Resolves true when the part may be cached. */
  done: Promise<boolean>;
  attach(fn: (delta: string) => void): void;
}

/** Buffers until it is this part's turn to stream. */
function startPart(
  p: PlanEntry,
  usage: ReviewUsage,
  signal: AbortSignal,
  onFailure: (err: unknown) => void,
): StartedPart {
  const buffer: string[] = [];
  const sink: { listener: ((delta: string) => void) | null } = {
    listener: null,
  };
  const push = (delta: string) => {
    if (sink.listener) {
      sink.listener(delta);
    } else {
      buffer.push(delta);
    }
  };
  const done = writePart(p, push, usage, signal);
  // Stops sibling parts rather than paying for them. Also keeps a rejection
  // that is never awaited from crashing the process.
  done.catch(onFailure);
  return {
    attach(fn) {
      for (const d of buffer.splice(0)) {
        fn(d);
      }
      sink.listener = fn;
    },
    done,
    kind: 'run',
    p,
  };
}

/**
 * `usage` is filled in place so a caller whose run throws still knows the
 * cost; it is final once the promise settles, since every part has stopped.
 */
export async function runReview(
  plan: ReviewPlan,
  emit: (delta: string) => void,
  signal?: AbortSignal,
  usage: ReviewUsage = emptyReviewUsage(),
): Promise<{ text: string; usage: ReviewUsage }> {
  const stop = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, stop.signal])
    : stop.signal;
  const stopFor = (err: unknown) => {
    if (!stop.signal.aborted) {
      stop.abort(
        err instanceof PartFailed
          ? err
          : new PartFailed(err, failureMayHaveBilled(err, combined.aborted)),
      );
    }
  };
  const runs = plan.parts.map((p) => {
    if (p.hit !== null) {
      return { kind: 'hit' as const, p, text: p.hit };
    }
    usage.cached = false;
    return startPart(p, usage, combined, stopFor);
  });
  const everyPart = () =>
    Promise.allSettled(runs.map((r) => (r.kind === 'run' ? r.done : null)));

  const chunks: string[] = [];
  const write = (delta: string) => {
    chunks.push(delta);
    emit(delta);
  };
  try {
    for (const run of runs) {
      if (run.kind === 'hit') {
        write(ensureTrailingNewline(run.text));
        continue;
      }
      const from = chunks.length;
      run.attach(write);
      const complete = await run.done;
      write('\n');
      const own = complete
        ? partText(chunks.slice(from).join(''), run.p.part)
        : null;
      if (own) {
        await cacheSet(run.p.key, own, 'luna-review-part');
      }
    }
  } catch (err) {
    stopFor(err);
    await everyPart();
    throw err;
  }
  return { text: chunks.join(''), usage };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

/** Keeps only sections the part owns, so a cached part cannot carry stray ones. */
function partText(own: string, part: ReviewPart): string | null {
  const parsed = parseSummaryText(own);
  if (part.role === 'overall') {
    return parsed.overall
      ? `Decision: ${parsed.decision}\n## Overall\n${parsed.overall}\n`
      : null;
  }
  const sections = parsed.files.filter((f) => ownsSection(part, f.path));
  if (!sections.length) {
    return null;
  }
  return sections.map((f) => `## ${f.path}\n${f.summary}\n`).join('');
}
