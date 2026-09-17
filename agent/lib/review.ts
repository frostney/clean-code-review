import type { Answers } from "./schema";

/**
 * What the page sends and what comes back. A review is a set of files —
 * whole files or the per-file hunks of a unified diff — and a judgment for
 * each one. Jev sees one file at a time; the fan-out is the runtime's job.
 */
export interface ReviewFile {
  /** Repo-relative path; doubles as the file's key in the result. */
  path: string;
  /** The file's text, or its unified-diff hunks when `patch` is true. */
  content: string;
  /** True when `content` is a diff of this file rather than the file itself. */
  patch?: boolean;
}

export interface ReviewInput {
  files: ReviewFile[];
}

export interface Usage {
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

/** Caps enforced on both ends. Jev is fast and cheap; these keep one review to one screen of results. */
export const REVIEW_LIMITS = {
  maxFiles: 24,
  maxCharsPerFile: 16_000,
} as const;

/** Trim an input to the caps rather than refusing it. */
export function clampReview(input: ReviewInput): ReviewInput {
  return {
    files: input.files.slice(0, REVIEW_LIMITS.maxFiles).map((f) => ({
      path: f.path,
      content: f.content.slice(0, REVIEW_LIMITS.maxCharsPerFile),
      ...(f.patch ? { patch: true } : {}),
    })),
  };
}

/** Extensions of images, media, fonts, archives and compiled artifacts: never code. */
const BINARY_EXT =
  /\.(svg|png|jpe?g|gif|ico|bmp|tiff?|webp|avif|heic|psd|ai|eps|mp3|mp4|mov|avi|webm|wav|ogg|flac|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|wasm|exe|dll|so|dylib|o|a|class|pyc|pyo|bin|dat|db|sqlite|parquet)$/i;

/** Lockfiles, minified bundles, generated code, snapshots, env files: not worth judging. Markdown and text are judged like any other file. */
const GENERATED_PATH =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|\.min\.(js|css)$|\.(snap|map|lock|csv)$|(^|\/)(dist|build|vendor|node_modules|__generated__|generated|\.changeset)\/|(^|\/)\.env(\.|$)/i;

/** Paths that are never judged, for callers that only have a path. */
export const SKIP_PATH = new RegExp(`${BINARY_EXT.source}|${GENERATED_PATH.source}`, "i");

/**
 * True when the content is not text: a NUL byte, a diff's "Binary files …
 * differ" marker with no hunks, or too many control characters in the first
 * few kilobytes.
 */
export function looksBinary(content: string): boolean {
  const sample = content.slice(0, 8_000);
  if (sample.includes("\0")) return true;
  if (/^Binary files .* differ$/m.test(sample) && !/^@@ /m.test(sample)) return true;
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) control++;
  }
  return sample.length > 0 && control / sample.length > 0.02;
}

export type SkipReason = "binary" | "generated";

/** Why a file is left out, or null when it should be judged. */
export function skipReason(file: { path: string; content: string }): SkipReason | null {
  if (BINARY_EXT.test(file.path) || looksBinary(file.content)) return "binary";
  if (GENERATED_PATH.test(file.path)) return "generated";
  return null;
}

/** Split a file list into what gets judged and what does not, with reasons. */
export function partitionJudgeable<T extends { path: string; content: string }>(
  files: readonly T[],
): { judgeable: T[]; skipped: { path: string; reason: SkipReason }[] } {
  const judgeable: T[] = [];
  const skipped: { path: string; reason: SkipReason }[] = [];
  for (const f of files) {
    const reason = skipReason(f);
    if (reason) skipped.push({ path: f.path, reason });
    else judgeable.push(f);
  }
  return { judgeable, skipped };
}
