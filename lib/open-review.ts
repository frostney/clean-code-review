import type { ReactNode } from 'react';

import { filesFromPatch } from '@/agent/lib/patch';
import type { Preset } from '@/agent/lib/presets';
import {
  isProsePath,
  partitionJudgeable,
  REVIEW_LIMITS,
  type ReviewFile,
  type SkipReason,
  skipReason,
} from '@/agent/lib/review';
import { selectReviewFiles } from '@/agent/lib/select';
import type { PullRequestPayload } from '@/app/actions';

import { splitPatchHeader } from './diff';
import { filesFromPaste, uniquePaths } from './paste';

/** The pull request a review came from, as the page holds it. */
interface OpenPullRequest {
  title: string;
  url: string;
  /** The description, rendered on the server. Null when there is none. */
  body: ReactNode;
  /** The same description as text, for the prompt that reaches Luna. */
  bodyText: string;
}

export interface OpenReview {
  /** Changes whenever a different set of files is opened, never on an edit. */
  id: string;
  /** The example this came from, for the chip that stays lit. */
  preset: string | null;
  /** Set when these files came from a GitHub pull request. */
  pr: OpenPullRequest | null;
  /** A patch file holds only its hunks here; its headers wait in `headers`. */
  files: ReviewFile[];
  /** Path → the `diff --git`/`index`/`---`/`+++` run lifted off that patch. */
  headers: Record<string, string>;
  /** How many files the paste or preset had before the cap, for the notice. */
  totalFiles: number;
  /** Paths whose text was cut to what one judgment reads. */
  truncated: Record<string, true>;
  /** Files that are not code, and why. Never rendered, always reported. */
  skipped: { path: string; reason: SkipReason }[];
  /**
   * Files a pull request had that never reached `skipped` because the diff
   * splitter dropped them first — binaries with no hunk, generated paths,
   * pure deletions. Counted against what GitHub said the PR touches.
   */
  skippedCount: number;
  /** Files a pull request had beyond the per-turn cap, for the notice. */
  dropped: number;
}

/**
 * What a review actually shows. Only what will be judged, and the prose that
 * goes with it, makes it onto the page: unique paths, because every key, edit
 * and judgment is by path; at most `maxFiles` code files, because a turn
 * judges no more than that, plus at most `maxProseFiles` of writing, which is
 * shown for context and never sent; and no more characters per file than one
 * is judged on, so the code on screen is the code Jev read.
 *
 * A patch file is split here as well: the headers are the file's name in
 * machine and are not on screen, so they are not edited either — they wait in
 * `headers` and go back on the moment the file is sent.
 *
 * Images, binaries and generated files never become a card. A judgment about a
 * PNG or a lockfile is noise, and the agent drops them on its side too — so
 * every way in goes through the same partition, and what it left out is said
 * out loud rather than silently missing.
 */
function opened(
  files: readonly ReviewFile[],
): Omit<OpenReview, 'id' | 'preset' | 'pr' | 'dropped' | 'skippedCount'> {
  const { skipped } = partitionJudgeable(files);
  // Code and prose in the order they came: a README pasted first stays first.
  const unique = uniquePaths(files.filter((f) => skipReason(f) === null));
  const truncated: Record<string, true> = {};
  const headers: Record<string, string> = {};
  const kept = withinCaps(unique).map((file) => {
    let shown = file;
    if (shown.content.length > REVIEW_LIMITS.maxCharsPerFile) {
      truncated[shown.path] = true;
      shown = {
        ...shown,
        content: shown.content.slice(0, REVIEW_LIMITS.maxCharsPerFile),
      };
    }
    if (!shown.patch) {
      return shown;
    }
    const { header, body } = splitPatchHeader(shown.content);
    if (header) {
      headers[shown.path] = header;
    }
    return { ...shown, content: body };
  });
  return {
    files: kept,
    headers,
    skipped,
    totalFiles: unique.length,
    truncated,
  };
}

/**
 * The first `maxFiles` code files and the first `maxProseFiles` prose files,
 * in the order they came. Two caps rather than one, so a change that is
 * mostly documentation does not spend the review's turn on files nobody is
 * asked about.
 */
function withinCaps(files: readonly ReviewFile[]): ReviewFile[] {
  let code = 0;
  let prose = 0;
  return files.filter((file) => {
    if (isProsePath(file.path)) {
      prose++;
      return prose <= REVIEW_LIMITS.maxProseFiles;
    }
    code++;
    return code <= REVIEW_LIMITS.maxFiles;
  });
}

export function fromPreset(preset: Preset, id: string): OpenReview {
  return {
    dropped: 0,
    id,
    pr: null,
    preset: preset.label,
    skippedCount: 0,
    ...opened(preset.files),
  };
}

/** A paste: a diff, a file, or several files marked up with `// file:` lines. */
export function fromPaste(text: string, id: string): OpenReview | null {
  const files = filesFromPaste(text);
  if (!files.length) {
    return null;
  }
  return {
    dropped: 0,
    id,
    pr: null,
    preset: null,
    skippedCount: 0,
    ...opened(files),
  };
}

/**
 * A pull request is a paste the page fetched for you. The diff is split per
 * file the same way a pasted one is, and then loses whatever is not worth a
 * judgment — lockfiles, bundles, images — before the review opens. Null when
 * nothing is left to judge.
 */
export function fromPullRequest(
  payload: PullRequestPayload,
  id: string,
): OpenReview | null {
  const judgeable = filesFromPatch(payload.diff);
  const { kept, skipped, dropped } = selectReviewFiles(judgeable);
  if (!kept.length) {
    return null;
  }
  const review = opened(kept);
  return {
    dropped: dropped.length,
    id,
    pr: {
      body: payload.body,
      bodyText: payload.bodyText,
      title: payload.title,
      url: payload.url,
    },
    preset: null,
    // What GitHub counted as touched, minus what survived the splitter.
    skippedCount: Math.max(0, payload.changedFiles - judgeable.length),
    ...review,
    // The diff splitter drops what is not code before this point, so the pull
    // request's own skip list and the partition's are the same list seen
    // twice; count each path once.
    skipped: [
      ...review.skipped,
      ...skipped
        .filter((path) => !review.skipped.some((s) => s.path === path))
        .map((path) => ({ path, reason: 'generated' as const })),
    ],
  };
}

/**
 * "Skipped 3 images or binaries and 2 generated files" — what never became a
 * card, in words. A pull request's diff is already filtered by the agent's own
 * splitter, so those files arrive as a bare count with no reason attached;
 * they are still worth saying, just less precisely.
 */
export function skippedText(
  skipped: readonly { reason: SkipReason }[],
  count: number,
): string | null {
  const binary = skipped.filter((s) => s.reason === 'binary').length;
  const generated = skipped.filter((s) => s.reason === 'generated').length;
  const parts: string[] = [];
  if (binary) {
    parts.push(
      `${binary} ${binary === 1 ? 'image or binary' : 'images or binaries'}`,
    );
  }
  if (generated) {
    parts.push(`${generated} generated ${generated === 1 ? 'file' : 'files'}`);
  }
  const unattributed = Math.max(0, count - skipped.length);
  if (unattributed) {
    parts.push(
      `${unattributed} generated or non-code ${unattributed === 1 ? 'file' : 'files'}`,
    );
  }
  return parts.length ? `Skipped ${parts.join(' and ')}` : null;
}
