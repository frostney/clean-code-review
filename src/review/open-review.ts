import type { ReactNode } from 'react';

import { filesFromPatch } from '@/agent/lib/judging/patch';
import { selectReviewFiles } from '@/agent/lib/judging/select';
import {
  isProsePath,
  partitionJudgeable,
  REVIEW_LIMITS,
  type ReviewFile,
  type SkipReason,
  skipReason,
} from '@/agent/lib/review/review';
import type { Preset } from '@/examples/presets';
import type { PullRequestPayload } from '@/src/pull-request/actions';

import { splitPatchHeader } from './diff';
import { filesFromPaste, uniquePaths } from './paste';

interface OpenPullRequest {
  title: string;
  url: string;
  /** Empty when there is none. */
  avatarUrl: string;
  /** Rendered on the server. */
  body: ReactNode;
  /** For Luna's prompt. */
  bodyText: string;
}

export interface OpenReview {
  /** Changes whenever a different set of files is opened, never on an edit. */
  id: string;
  /** Preset label. */
  preset: string | null;
  pr: OpenPullRequest | null;
  /** A patch file holds only its hunks here; its headers are in `headers`. */
  files: ReviewFile[];
  /** Path → the `diff --git`/`index`/`---`/`+++` lines lifted off that patch. */
  headers: Record<string, string>;
  /** Counts before the caps, per kind because each kind is capped separately. */
  total: { code: number; prose: number };
  truncated: Record<string, true>;
  /** Not code; reported, never rendered as cards. */
  skipped: { path: string; reason: SkipReason }[];
  /**
   * Files the diff splitter dropped before `skipped` (no hunk, generated,
   * deleted), counted against GitHub's changed-file total.
   */
  skippedCount: number;
}

/**
 * Paths are made unique because every key, edit and judgment is by path.
 * Content is truncated to what one judgment reads, so the code on screen is
 * the code Jev read. Patch headers are lifted into `headers` so they are not
 * edited, and go back on when the file is sent.
 */
function opened(
  files: readonly ReviewFile[],
): Omit<OpenReview, 'id' | 'preset' | 'pr' | 'skippedCount'> {
  const { skipped } = partitionJudgeable(files);
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
    total: countKinds(unique),
    truncated,
  };
}

function countKinds(files: readonly ReviewFile[]): {
  code: number;
  prose: number;
} {
  const prose = files.filter((file) => isProsePath(file.path)).length;
  return { code: files.length - prose, prose };
}

// Two caps, so mostly-documentation changes do not crowd out code.
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
    id,
    pr: null,
    preset: preset.label,
    skippedCount: 0,
    ...opened(preset.files),
  };
}

export function fromPaste(text: string, id: string): OpenReview | null {
  const files = filesFromPaste(text);
  if (!files.length) {
    return null;
  }
  return {
    id,
    pr: null,
    preset: null,
    skippedCount: 0,
    ...opened(files),
  };
}

/** Null when nothing is left to judge. */
export function fromPullRequest(
  payload: PullRequestPayload,
  id: string,
): OpenReview | null {
  const judgeable = filesFromPatch(payload.diff);
  const { kept, skipped } = selectReviewFiles(judgeable);
  if (!kept.length) {
    return null;
  }
  const review = opened(kept);
  return {
    id,
    pr: {
      avatarUrl: payload.avatarUrl,
      body: payload.body,
      bodyText: payload.bodyText,
      title: payload.title,
      url: payload.url,
    },
    preset: null,
    skippedCount: Math.max(0, payload.changedFiles - judgeable.length),
    ...review,
    // Both lists can name the same path; count it once.
    skipped: [
      ...review.skipped,
      ...skipped
        .filter((path) => !review.skipped.some((s) => s.path === path))
        .map((path) => ({ path, reason: 'generated' as const })),
    ],
    // `selectReviewFiles` already capped the list `opened` counted, so
    // recount from the whole pull request.
    total: countKinds(judgeable.filter((f) => skipReason(f) === null)),
  };
}

// Files the diff splitter dropped arrive only as `count`, with no reason.
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

export function cappedText(review: OpenReview): string | null {
  const shownProse = review.files.filter((f) => isProsePath(f.path)).length;
  const shown = { code: review.files.length - shownProse, prose: shownProse };
  const counts: string[] = [];
  const reasons: string[] = [];
  if (review.total.code > shown.code) {
    counts.push(`${shown.code} of ${review.total.code} code files`);
    reasons.push(
      `a review is judged in one turn, and one turn carries ${REVIEW_LIMITS.maxFiles} code files`,
    );
  }
  if (review.total.prose > shown.prose) {
    counts.push(`${shown.prose} of ${review.total.prose} prose files`);
    reasons.push(
      `prose is shown for context and never judged, so ${REVIEW_LIMITS.maxProseFiles} of it is enough`,
    );
  }
  if (!counts.length) {
    return null;
  }
  return `Showing ${counts.join(' and ')}: ${reasons.join(', and ')}.`;
}
