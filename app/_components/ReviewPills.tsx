"use client";

import { meanVerdict, smellCount, smellLabel, verdictOf, verdictScore } from "@/lib/display";
import type { ReviewState } from "@/lib/useReview";

/**
 * What the whole review amounts to right now, as three pills: Jev's verdict
 * across every file it has judged, how many smells that adds up to, and which
 * model is working.
 *
 * They sit on the overall review card's bottom line rather than beside a page
 * title, so the one line that carries a conclusion carries all of it: Luna's
 * decision, then Jev's verdict and count, then who wrote the prose.
 */
export function ReviewPills({ review }: { review: ReviewState }) {
  const judged = Object.values(review.judgments);
  const verdict = verdictOf(meanVerdict(judged.map((j) => verdictScore(j.answers))));
  const smells = judged.reduce((total, j) => total + smellCount(j.answers), 0);

  return (
    <>
      <span
        data-verdict={verdict.key}
        className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-tiny font-semibold ${verdict.className}`}
      >
        {verdict.key === "pending" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted" />}
        {verdict.label}
      </span>
      {judged.length > 0 && (
        <span
          data-smells-total={smells}
          className={`rounded-full px-2 py-0.5 text-tiny font-semibold ${
            smells ? "bg-bad-bg text-bad" : "bg-track text-muted"
          }`}
        >
          {smellLabel(smells)}
        </span>
      )}
      <ReviewStatus review={review} />
    </>
  );
}

/**
 * A dot and a word, and nothing at all when nothing is happening. Two models
 * answer here and they take different amounts of time, so this says which one
 * is working: Jev judging, or Luna writing the review.
 */
function ReviewStatus({ review }: { review: ReviewState }) {
  const base = "flex items-center gap-1.5 text-tiny";
  if (review.budgetSpent) {
    return (
      <span data-status="budget-spent" className={`${base} text-muted`}>
        budget spent
      </span>
    );
  }
  if (review.error) {
    return (
      <span data-status="error" className={`${base} text-bad`}>
        {review.error}
      </span>
    );
  }
  if (review.asking) {
    return (
      <span data-status="judging" className={`${base} text-muted`}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
        judging…
      </span>
    );
  }
  if (review.summary.running) {
    return (
      <span data-status="reviewing" className={`${base} text-muted`}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        reviewing…
      </span>
    );
  }
  return null;
}
