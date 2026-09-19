'use client';

import { reviewVerdict, smellCount, smellLabel, verdictScore } from './display';
import { PendingDot } from './PendingDot';
import type { ReviewState } from './useReview';

export function ReviewPills({
  judgeable = true,
  review,
  stalled = false,
}: {
  /** False when no answer can ever arrive, so the pill must not pulse. */
  judgeable?: boolean;
  review: ReviewState;
  stalled?: boolean;
}) {
  const judged = Object.values(review.judgments);
  const verdict = reviewVerdict(
    judged.map((j) => verdictScore(j.answers)),
    judgeable,
    review.paused !== null,
    !review.asking && stalled,
  );
  const smells = judged.reduce((total, j) => total + smellCount(j.answers), 0);

  return (
    <>
      <span
        className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${verdict.className}`}
        data-verdict={verdict.key}
      >
        {verdict.key === 'pending' && <PendingDot />}
        {verdict.label}
      </span>
      {judged.length > 0 && (
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            smells ? 'bg-bad-bg text-bad' : 'bg-track text-muted'
          }`}
          data-smells-total={smells}
        >
          {smellLabel(smells)}
        </span>
      )}
      <ReviewStatus review={review} />
    </>
  );
}

// Says which model is working, since Jev and Luna take very different times.
function ReviewStatus({ review }: { review: ReviewState }) {
  const base = 'flex items-center gap-1.5 text-xs';
  if (review.budgetSpent) {
    return (
      <span className={`${base} text-muted`} data-status="budget-spent">
        budget spent
      </span>
    );
  }
  if (review.paused) {
    // With nothing judged, the verdict pill already says "Paused".
    return Object.keys(review.judgments).length ? (
      <span className={`${base} text-muted`} data-status="paused">
        paused
      </span>
    ) : null;
  }
  // Failures are shown once, in the toast with Retry (`ReviewToasts`).
  if (review.error && !review.asking) {
    return null;
  }
  if (review.asking) {
    return (
      <span className={`${base} text-muted`} data-status="judging">
        <PendingDot tone="bg-warn" />
        judging…
      </span>
    );
  }
  if (review.summary.running) {
    return (
      <span className={`${base} text-muted`} data-status="reviewing">
        <PendingDot tone="bg-accent" />
        reviewing…
      </span>
    );
  }
  return null;
}
