'use client';

import { useReviewView } from './ReviewProvider';

export function ReviewStats() {
  const { open, review, reviewState, lineCount } = useReviewView();

  if (!open) {
    return null;
  }
  const fileCount = review.files.length;
  const cached = reviewState.cached || reviewState.summary.cached;

  return (
    <p className="mt-2 text-xs text-muted">
      {fileCount} {fileCount === 1 ? 'file' : 'files'} · {lineCount} lines ·
      last turn{' '}
      {reviewState.lastTurnMs === null ? '—' : `${reviewState.lastTurnMs} ms`}
      {cached ? (
        <>
          {' '}
          &middot;{' '}
          <span className="text-subtle" data-cached="1">
            from cache
          </span>
        </>
      ) : null}
    </p>
  );
}
