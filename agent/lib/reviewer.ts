/**
 * The reviewer: Luna writes the prose half of the review from Jev's findings.
 *
 * A review is split into parts — batches of files, plus one overall part with
 * the decision — and every part is one model call, all started at once
 * through the AI Gateway. The parts are streamed back to the caller in a
 * fixed order (overall first, then the batches), so the combined text is
 * always a well-formed review even while it is still arriving: a part that
 * finished early simply flushes when its turn comes. Each part is cached for
 * an hour on its own, but only once it has finished on its own: a part cut
 * off at its output ceiling is written once more with twice the room, and one
 * cut off even then is shown as far as it got, marked incomplete, and never
 * cached.
 *
 * Every part that ran is paid for, finished or not. A part that reports its
 * cost adds that; one that fails or is cancelled first cannot say, and adds
 * what it plausibly used instead (`lunaFailedCallUsd` in `./spend.ts`): its
 * prompt and what it had streamed, or nothing when it was never sent or was
 * turned away.
 *
 * The model's text never reaches the reader as it was written: a file part
 * has read someone else's code, so every line of it shaped like one of the
 * adapter's signal lines is dropped (`withoutSignalLines`).
 */
import { streamText } from 'ai';

import { cacheGet, cacheKey, cacheSet } from './cache';
import type { SummarizeInput } from './prompt';
import { questionById, SMELL_IDS } from './questions';
import { REVIEWER_INSTRUCTIONS } from './reviewer-prompt';
import {
  failureWasProcessed,
  lunaCostUsd,
  lunaFailedCallUsd,
  lunaPartEstimateUsd,
} from './spend';
import {
  cutOffLine,
  OVERALL_REWRITE_LINE,
  OVERALL_SECTION,
  parseSummaryText,
  REVIEW_BATCH_SIZE,
  REVIEWER_MODEL,
  type ReviewPart,
  withoutSignalLines,
} from './summary';

/**
 * Bump when the reviewer's instructions change, so cached parts expire. 11:
 * parts cached before model text was stripped of signal lines.
 */
const REVIEW_VERSION = 11;

/** How much of a file a file part is shown; the findings carry the rest. */
const FILE_EXCERPT_CHARS = 8_000;

/** How much of a pull request's body the overall part is shown. */
const PR_BODY_CHARS = 2_000;

/**
 * A ceiling on what one part may write, reasoning included, as a safety net
 * and never as a length control: the 300-character rule per file is the
 * prompt's to keep. A file part is fed up to 8,000 characters of someone
 * else's code per file, and without a ceiling that text could keep the model
 * writing. The most measured on real reviews, over few samples, was 816
 * tokens for a 6-file batch of a 24-file pull request and 183 for the overall
 * part, so these sit five and ten times above that. A part that reaches its
 * ceiling anyway is written again with `RETRY_CEILING_FACTOR` times the room.
 */
const MAX_OUTPUT_TOKENS: Record<ReviewPart['role'], number> = {
  files: 4000,
  overall: 2000,
};

/** How much more room a part cut off at its ceiling is given for its one retry. */
const RETRY_CEILING_FACTOR = 2;

/** Jev's yes/no answers are odds; at even odds or better the smell is a finding. */
const EVEN_ODDS = 0.5;

/** The top of the five-level score scale the questions answer on. */
const TOP_LEVEL = 4;

/** How many findings the overall part is given per file: the strongest few. */
const OVERALL_FINDINGS = 5;

/** What the reviewer is told: Jev's findings per file, in words, and nothing else. */
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
    // A file part reads the file first, then applies the judge's findings to it.
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

/** A part as a run starts it: from the cache, or to be written. */
interface PlanEntry extends PlannedPart {
  /** The cached text, or null when Luna has to write it. */
  hit: string | null;
}

/** A review about to run: every part, and which of them the cache already has. */
export interface ReviewPlan {
  parts: PlanEntry[];
}

/** Overall first, then batches of files, in order. */
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

/** Plan a review: its parts, and a cache read for each. */
export async function planReview(input: SummarizeInput): Promise<ReviewPlan> {
  const parts = await Promise.all(
    planParts(input).map(async (p) => ({
      ...p,
      hit: (await cacheGet<string>(p.key)) || null,
    })),
  );
  return { parts };
}

/** Everything one attempt at a part is sent. */
const promptChars = (p: PlannedPart) =>
  p.message.length + REVIEWER_INSTRUCTIONS.length;

/** What one attempt at a part is reserved at: its prompt, and its output at the full ceiling. */
function attemptEstimateUsd(p: PlannedPart, ceiling: number): number {
  return lunaPartEstimateUsd(promptChars(p), ceiling);
}

/**
 * What running this plan is reserved at: one attempt at each part the cache
 * does not have, at its full ceiling. Zero when the whole review is cached.
 */
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
  /** What the parts that reported cost, by the gateway or, failing that, by their tokens. */
  costUsd: number;
  /** What every attempt that never reported plausibly cost: failed, cancelled or timed out. */
  unreportedUsd: number;
  /** True when every part came from the cache. */
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

/** What a review is settled at: what reported, and what the rest plausibly cost. */
export function reviewChargeUsd(usage: ReviewUsage): number {
  return usage.costUsd + usage.unreportedUsd;
}

/**
 * Why the other parts of a review were stopped: one part failed. They were
 * sent to the same gateway at the same moment, so a part stopped with nothing
 * written is charged as the failed one was: nothing when that one was turned
 * away (a bad key, a rate limit, no connection), its prompt otherwise.
 */
class PartFailed extends Error {
  readonly processed: boolean;
  constructor(cause: unknown, processed: boolean) {
    super('another part of the review failed', { cause });
    this.processed = processed;
  }
}

/**
 * Read one attempt's stream to its end: its text to `text`, and every
 * character of output, answer and reasoning, counted in `seen`. Throws when
 * the call failed or was cancelled, which the stream reports as a part.
 */
async function readParts(
  parts: AsyncIterable<{ type: string; text?: string; error?: unknown }>,
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
      throw new Error('the model call was aborted');
    }
  }
  text.end();
}

/**
 * One attempt at a part: stream its text to `push`, without signal lines,
 * then add what it cost to `usage`. Resolves with why it stopped. An attempt
 * whose signal has already aborted is never sent, and costs nothing. One
 * that fails or is cancelled, which the SDK reports as an error part or by
 * throwing from its usage, adds what it plausibly used and throws.
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
  });
  const text = withoutSignalLines(push);
  /** Output received, answer and reasoning both: what a failed call is charged for. */
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
      outputChars: seen.chars,
      processed:
        stoppedFor instanceof PartFailed
          ? stoppedFor.processed
          : failureWasProcessed(err, signal.aborted),
      sent: true,
    });
    throw err;
  }
}

/** The section a part's own text stopped in: its last heading, or null when it wrote none. */
function lastSection(text: string): string | null {
  const parsed = parseSummaryText(text);
  return parsed.files.at(-1)?.path ?? (parsed.overall ? OVERALL_SECTION : null);
}

/**
 * Write one part: one attempt, and one more with twice the room if the first
 * ran into its ceiling. Resolves true when the part finished on its own and
 * may be cached. A part cut off twice is left as far as it got, followed by a
 * `cutOffLine` for the section it stopped in and each one it never reached.
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
    // An overall part that wrote nothing at all is still the overall that is missing.
    ...(p.part.role === 'overall' && stopped === null ? [OVERALL_SECTION] : []),
  ];
  push(`\n${cut.map(cutOffLine).join('\n')}\n`);
  return false;
}

interface StartedPart {
  kind: 'run';
  p: PlanEntry;
  /** Settles when the part has stopped, with whether it may be cached. */
  done: Promise<boolean>;
  attach(fn: (delta: string) => void): void;
}

/** Start one uncached part now; it buffers until it is its turn to stream. */
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
  // One part failing fails the review, so the others are stopped rather than
  // paid for. Awaited in order below, and heard there; this handler is also
  // what keeps a rejection nobody reached from ending the process.
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
 * Run a planned review. `emit` receives text in order. `usage` is filled in
 * place, so a caller whose run throws still knows what it cost; the promise
 * only settles once every part has stopped, so by then that figure is final.
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
  /** Stop every part, because one failed with `err`. */
  const stopFor = (err: unknown) => {
    if (!stop.signal.aborted) {
      stop.abort(
        err instanceof PartFailed
          ? err
          : new PartFailed(err, failureWasProcessed(err, combined.aborted)),
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
      // Cache this part on its own, from its own text: everything written
      // since it started. Never a part that was cut off.
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

/** A part's own text, re-serialised for the cache. */
function partText(own: string, part: ReviewPart): string | null {
  const parsed = parseSummaryText(own);
  if (part.role === 'overall') {
    return parsed.overall
      ? `Decision: ${parsed.decision}\n## Overall\n${parsed.overall}\n`
      : null;
  }
  const sections = parsed.files.filter((f) => part.paths.includes(f.path));
  if (!sections.length) {
    return null;
  }
  return sections.map((f) => `## ${f.path}\n${f.summary}\n`).join('');
}
