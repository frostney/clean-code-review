'use client';

import { useReviewView } from './ReviewProvider';

/**
 * How much code is on screen and how long the last turn took. The size of the
 * review is what makes its timing readable — 24 files in 600 ms is the claim
 * this page is making, and this is the line that makes it.
 */
export function ReviewStats() {
  const { open, review, judge, lineCount } = useReviewView();
  // Nothing is open, so there is nothing to be the size of. A line reading
  // "0 files · 0 lines" under the field is a claim about an empty page.
  if (!open) {
    return null;
  }
  const fileCount = review.files.length;
  const cached = judge.cached || judge.summary.cached;

  return (
    <p className="mt-2 text-[12px] text-muted">
      {fileCount} {fileCount === 1 ? 'file' : 'files'} · {lineCount} lines ·
      last turn {judge.ms === null ? '—' : `${judge.ms} ms`}
      {cached ? (
        <>
          {' '}
          &middot;{' '}
          <span className="text-muted/70" data-cached="1">
            from cache
          </span>
        </>
      ) : null}
    </p>
  );
}
