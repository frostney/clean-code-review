import type { Answers } from '../judging/schema';

export interface ReviewFile {
  /** Also the file's key in the result. */
  path: string;
  content: string;
  /** `content` is this file's unified-diff hunks rather than the whole file. */
  patch?: boolean;
}

export interface ReviewInput {
  files: ReviewFile[];
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface FileJudgment {
  answers: Answers;
  usage: Usage;
  ms: number;
  cached?: boolean;
  /**
   * How much of the verdict rests on the file's comments: the verdict of the
   * file as written minus the verdict of the same file with its comments
   * removed. Both passes read the same lines in the same windows, with one
   * exception: a window whose every line was a comment is not sent at all in
   * the second pass, so a file that holds one is compared over one window
   * fewer. That window has no code to fault, so it understates the lean rather
   * than inventing one. Absent when the file was judged in one pass.
   */
  commentLean?: number;
  /** Windows of the file that answered as written; above one, it was read in parts. */
  windows?: number;
  /**
   * Windows the file was cut into. Fewer answered than this means part of the
   * file went unjudged, so the answers are the worst of what was read: judging
   * the rest can only lower the verdict and add smells.
   */
  windowsPlanned?: number;
  /**
   * A window answered as written but not with its comments removed, so its
   * code was judged with the comments in view and there is no `commentLean`.
   */
  strippedMissing?: boolean;
  /** The file was longer than `maxJudgedChars`; the rest was not judged. */
  cut?: boolean;
}

export interface ReviewResult {
  model: string;
  /** A file Jev could not judge is absent. */
  files: Record<string, FileJudgment>;
  usage: Usage;
}

/**
 * Per browser tab. Lives here, not in `agent/agent.ts`, because the page
 * quotes it and importing the agent would pull in eve's runtime.
 */
export const SESSION_COST_CAP_USD = 0.5;

/** Enforced by both page and agent; they keep one review to one screen of results. */
export const REVIEW_LIMITS = {
  maxCharsPerFile: 16_000,
  maxFiles: 24,
  /** Not judged, so not counted against `maxFiles`. */
  maxProseFiles: 10,
  /**
   * A longer file is judged in this many windows of `maxCharsPerFile` and cut
   * after them. Four covers the largest source in this repository (43,685
   * characters) with a window to spare; `MAX_JUDGE_CALLS_PER_FILE` is what it
   * costs.
   */
  maxWindowsPerFile: 4,
} as const;

/** The most of one file any judgement reads. */
export const MAX_JUDGED_CHARS =
  REVIEW_LIMITS.maxCharsPerFile * REVIEW_LIMITS.maxWindowsPerFile;

/**
 * Every window is read as written and again with its comments removed, which
 * is how `commentLean` is measured; `judge.ts` skips the second pass when
 * there is nothing to remove.
 */
const JUDGE_PASSES = 2;

/**
 * The most calls judging one file plans. Not the most requests it makes:
 * `withOneRetry` in `judge.ts` sends a second attempt for a call that times
 * out or comes back 408, 429 or 5xx, so the gateway can see twice this, each
 * carrying the same window again. Quoted by `/privacy`, which says both.
 */
export const MAX_JUDGE_CALLS_PER_FILE =
  REVIEW_LIMITS.maxWindowsPerFile * JUDGE_PASSES;

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

function inRange(code: number, first: number, last: number): boolean {
  return code >= first && code <= last;
}

/**
 * Cuts on a code-point boundary, so an emoji is dropped rather than halved.
 * Every cut of code on its way to a judgement goes through this.
 */
export function cappedAt(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const splits =
    inRange(
      text.charCodeAt(limit - 1),
      HIGH_SURROGATE_FIRST,
      HIGH_SURROGATE_LAST,
    ) &&
    inRange(text.charCodeAt(limit), LOW_SURROGATE_FIRST, LOW_SURROGATE_LAST);

  return text.slice(0, splits ? limit - 1 : limit);
}

/**
 * `maxChars` is `maxCharsPerFile` for anything that reads a file whole, and
 * `MAX_JUDGED_CHARS` for the judge, which reads a long file in windows.
 */
export function clampReview(
  input: ReviewInput,
  maxChars: number = REVIEW_LIMITS.maxCharsPerFile,
): ReviewInput {
  return {
    files: input.files.slice(0, REVIEW_LIMITS.maxFiles).map((f) => ({
      content: cappedAt(f.content, maxChars),
      path: f.path,
      ...(f.patch ? { patch: true } : {}),
    })),
  };
}

const BINARY_EXT =
  /\.(svg|png|jpe?g|gif|ico|bmp|tiff?|webp|avif|heic|psd|ai|eps|mp3|mp4|mov|avi|webm|wav|ogg|flac|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|wasm|exe|dll|so|dylib|o|a|class|pyc|pyo|bin|dat|db|sqlite|parquet)$/i;

/** Shown for context but never judged: the questions are about code. */
const PROSE_EXT = /\.(md|mdx|markdown|mkd|txt|text|rst|adoc|asciidoc|org)$/i;

export function isProsePath(path: string): boolean {
  return PROSE_EXT.test(path);
}

const GENERATED_PATH =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|\.min\.(js|css)$|\.(snap|map|lock|csv)$|(^|\/)(dist|build|vendor|node_modules|__generated__|generated|\.changeset)\/|(^|\/)\.env(\.|$)/i;

const BINARY_SAMPLE_CHARS = 8_000;

const FIRST_PRINTABLE = 32;

const TAB = 9;
const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const LAYOUT_CONTROLS = new Set([TAB, NEWLINE, CARRIAGE_RETURN]);

const MAX_CONTROL_SHARE = 0.02;

function looksBinary(content: string): boolean {
  const sample = content.slice(0, BINARY_SAMPLE_CHARS);

  if (sample.includes('\0')) {
    return true;
  }
  if (/^Binary files .* differ$/m.test(sample) && !/^@@ /m.test(sample)) {
    return true;
  }
  let controlCount = 0;

  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);

    if (c < FIRST_PRINTABLE && !LAYOUT_CONTROLS.has(c)) {
      controlCount++;
    }
  }

  return sample.length > 0 && controlCount / sample.length > MAX_CONTROL_SHARE;
}

export type SkipReason = 'binary' | 'generated';

export function skipReason(file: {
  path: string;
  content: string;
}): SkipReason | null {
  if (BINARY_EXT.test(file.path) || looksBinary(file.content)) {
    return 'binary';
  }
  if (GENERATED_PATH.test(file.path)) {
    return 'generated';
  }

  return null;
}

/** Every entry point must use this one partition, so page and agent agree on what is judged. */
export function partitionJudgeable<T extends { path: string; content: string }>(
  files: readonly T[],
): {
  judgeable: T[];
  prose: T[];
  skipped: { path: string; reason: SkipReason }[];
} {
  const judgeable: T[] = [];
  const prose: T[] = [];
  const skipped: { path: string; reason: SkipReason }[] = [];

  for (const f of files) {
    const reason = skipReason(f);

    if (reason) {
      skipped.push({ path: f.path, reason });
    } else if (isProsePath(f.path)) {
      prose.push(f);
    } else {
      judgeable.push(f);
    }
  }

  return { judgeable, prose, skipped };
}
