import type { Answers } from '../judging/schema';

/**
 * What the page sends and what comes back. A review is a set of files —
 * whole files or the per-file hunks of a unified diff — and a judgment for
 * each one. Jev sees one file at a time; the fan-out is the runtime's job.
 */
export interface ReviewFile {
  /**
   * Repo-relative path; doubles as the file's key in the result. A prose path
   * (see `isProsePath`) is shown with the review but never judged.
   */
  path: string;
  /** The file's text, or its unified-diff hunks when `patch` is true. */
  content: string;
  /** True when `content` is a diff of this file rather than the file itself. */
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
  /** Wall-clock time of this file's evaluation, in milliseconds. */
  ms: number;
  /** True when the answers came from the one-hour cache rather than a fresh evaluation. */
  cached?: boolean;
}

export interface ReviewResult {
  model: string;
  /** One judgment per input path. A file Jev could not judge is absent. */
  files: Record<string, FileJudgment>;
  usage: Usage;
}

/**
 * What one browser tab may spend on models before the agent stops and asks.
 * It lives here rather than in `agent/agent.ts` because the page quotes it:
 * importing the agent into a React component would pull eve's runtime with it.
 */
export const SESSION_COST_CAP_USD = 0.5;

/** Caps enforced on both ends. Jev is fast and cheap; these keep one review to one screen of results. */
export const REVIEW_LIMITS = {
  maxCharsPerFile: 16_000,
  maxFiles: 24,
  /** Prose files shown alongside a review. They are not judged, so they do not count against `maxFiles`. */
  maxProseFiles: 10,
} as const;

/** Trim an input to the caps rather than refusing it. */
export function clampReview(input: ReviewInput): ReviewInput {
  return {
    files: input.files.slice(0, REVIEW_LIMITS.maxFiles).map((f) => ({
      content: f.content.slice(0, REVIEW_LIMITS.maxCharsPerFile),
      path: f.path,
      ...(f.patch ? { patch: true } : {}),
    })),
  };
}

/** Extensions of images, media, fonts, archives and compiled artifacts: never code. */
const BINARY_EXT =
  /\.(svg|png|jpe?g|gif|ico|bmp|tiff?|webp|avif|heic|psd|ai|eps|mp3|mp4|mov|avi|webm|wav|ogg|flac|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|wasm|exe|dll|so|dylib|o|a|class|pyc|pyo|bin|dat|db|sqlite|parquet)$/i;

/**
 * Documentation and other writing. Clean Code is a book about code, so a
 * README or a changelog is shown for context — a pull request is read with its
 * description — but none of the questions is asked about it.
 */
const PROSE_EXT = /\.(md|mdx|markdown|mkd|txt|text|rst|adoc|asciidoc|org)$/i;

/** True for a file that is writing rather than code: shown, never judged. */
export function isProsePath(path: string): boolean {
  return PROSE_EXT.test(path);
}

/** Lockfiles, minified bundles, generated code, snapshots, env files: not worth judging. */
const GENERATED_PATH =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|\.min\.(js|css)$|\.(snap|map|lock|csv)$|(^|\/)(dist|build|vendor|node_modules|__generated__|generated|\.changeset)\/|(^|\/)\.env(\.|$)/i;

/** How much of a file is read when deciding whether it is text at all. */
const BINARY_SAMPLE_CHARS = 8_000;

/** Below this code point a character is a control character. */
const FIRST_PRINTABLE = 32;

/** The three control characters text is written with. */
const TAB = 9;
const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const LAYOUT_CONTROLS = new Set([TAB, NEWLINE, CARRIAGE_RETURN]);

/** Above this share of control characters the content is not text. */
const MAX_CONTROL_SHARE = 0.02;

/**
 * True when the content is not text: a NUL byte, a diff's "Binary files …
 * differ" marker with no hunks, or too many control characters in the first
 * few kilobytes.
 */
function looksBinary(content: string): boolean {
  const sample = content.slice(0, BINARY_SAMPLE_CHARS);
  if (sample.includes('\0')) {
    return true;
  }
  if (/^Binary files .* differ$/m.test(sample) && !/^@@ /m.test(sample)) {
    return true;
  }
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < FIRST_PRINTABLE && !LAYOUT_CONTROLS.has(c)) {
      control++;
    }
  }
  return sample.length > 0 && control / sample.length > MAX_CONTROL_SHARE;
}

export type SkipReason = 'binary' | 'generated';

/** Why a file is left out, or null when it should be judged. */
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

/**
 * Split a file list three ways: what gets judged, the prose that is shown
 * beside it, and what is left out altogether, with reasons. Every way in —
 * paste, example, pull request, a JSON turn from any other client — goes
 * through this one partition, so no path is judged on one side and not the
 * other.
 */
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
