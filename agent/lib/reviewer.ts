/**
 * The reviewer: Luna writes the prose half of the review from Jev's findings.
 *
 * A review is split into parts — batches of files, plus one overall part with
 * the decision — and every part is one model call, all started at once
 * through the AI Gateway. The parts are streamed back to the caller in a
 * fixed order (overall first, then the batches), so the combined text is
 * always a well-formed review even while it is still arriving: a part that
 * finished early simply flushes when its turn comes. Each part is cached for
 * an hour on its own.
 */
import { streamText } from 'ai';

import { cacheGet, cacheKey, cacheSet } from './cache';
import type { SummarizeInput } from './prompt';
import { questionById, SMELL_IDS } from './questions';
import { REVIEWER_INSTRUCTIONS } from './reviewer-prompt';
import {
  parseSummaryText,
  REVIEW_BATCH_SIZE,
  REVIEWER_MODEL,
  type ReviewPart,
} from './summary';

/** Bump when the reviewer's instructions change, so cached parts expire. */
const REVIEW_VERSION = 10;

/** How much of a file a file part is shown; the findings carry the rest. */
const FILE_EXCERPT_CHARS = 8_000;

/** How much of a pull request's body the overall part is shown. */
const PR_BODY_CHARS = 2_000;

/**
 * A ceiling on what one part may write, reasoning included, as a safety net
 * and never as a length control: the 300-character rule per file is the
 * prompt's to keep. A file part is fed up to 8,000 characters of someone
 * else's code per file, and without a ceiling that text could keep the model
 * writing. Each is about four times the most measured on real reviews (a
 * 6-file batch of a 24-file pull request wrote 816 tokens, the overall part
 * of five reviews at most 183), so no normal review comes near it.
 */
const MAX_OUTPUT_TOKENS: Record<ReviewPart['role'], number> = {
  files: 3300,
  overall: 750,
};

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

/**
 * True when every part of this review is cached, so writing it now would cost
 * nothing. Cache reads only, for a caller out of model budget.
 */
export async function allReviewed(input: SummarizeInput) {
  const hits = await Promise.all(
    planParts(input).map(async (p) => Boolean(await cacheGet<string>(p.key))),
  );
  return hits.every(Boolean);
}

export interface ReviewUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** True when every part came from the cache. */
  cached: boolean;
}

/**
 * Run the review. `emit` receives text in order; the returned promise settles
 * with the full text and the usage once every part is done.
 */
export async function runReview(
  input: SummarizeInput,
  emit: (delta: string) => void,
  signal?: AbortSignal,
): Promise<{ text: string; usage: ReviewUsage }> {
  const planned = planParts(input);
  const usage: ReviewUsage = {
    cached: true,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  // Start every uncached part now; each one buffers until it is its turn to stream.
  const runs = await Promise.all(
    planned.map(async (p) => {
      const hit = await cacheGet<string>(p.key);
      if (hit) {
        return { kind: 'hit' as const, p, text: hit };
      }
      usage.cached = false;
      const buffer: string[] = [];
      const sink: { listener: ((delta: string) => void) | null } = {
        listener: null,
      };
      const stream = streamText({
        abortSignal: signal,
        maxOutputTokens: MAX_OUTPUT_TOKENS[p.part.role],
        model: REVIEWER_MODEL,
        prompt: p.message,
        system: REVIEWER_INSTRUCTIONS,
      });
      const done = (async () => {
        for await (const delta of stream.textStream) {
          if (sink.listener) {
            sink.listener(delta);
          } else {
            buffer.push(delta);
          }
        }
        const u = await stream.usage;
        const meta = await stream.providerMetadata;
        usage.inputTokens += u?.inputTokens ?? 0;
        usage.outputTokens += u?.outputTokens ?? 0;
        usage.costUsd += Number(
          (meta?.gateway as { cost?: string } | undefined)?.cost ?? 0,
        );
      })();
      // Awaited in order below. When an earlier part fails, the loop stops
      // and never reaches this one, and its rejection must not go unobserved:
      // Node ends a process on an unhandled rejection.
      done.catch(() => {
        /* The loop below is where a failure is heard. */
      });
      return {
        attach(fn: (delta: string) => void) {
          for (const d of buffer.splice(0)) {
            fn(d);
          }
          sink.listener = fn;
        },
        done,
        kind: 'run' as const,
        p,
      };
    }),
  );

  const chunks: string[] = [];
  for (const run of runs) {
    const write = (delta: string) => {
      chunks.push(delta);
      emit(delta);
    };
    if (run.kind === 'hit') {
      write(ensureTrailingNewline(run.text));
      continue;
    }
    run.attach(write);
    await run.done;
    write('\n');
    const text = chunks.join('');
    // Cache this part on its own: its text is everything written since it started.
    const own = partText(text, run.p.part);
    if (own) {
      await cacheSet(run.p.key, own, 'luna-review-part');
    }
  }
  return { text: chunks.join(''), usage };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

/** The slice of the combined text that belongs to one part, re-serialised. */
function partText(all: string, part: ReviewPart): string | null {
  const parsed = parseSummaryText(all);
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
