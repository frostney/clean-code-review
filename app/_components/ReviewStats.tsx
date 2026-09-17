"use client";

import { useReviewView } from "./ReviewProvider";

/**
 * How much code is on screen and how long the last turn took. The size of the
 * review is what makes its timing readable — 24 files in 600 ms is the claim
 * this page is making, and this is the line that makes it.
 */
export function ReviewStats() {
  const { review, judge, lineCount } = useReviewView();
  const fileCount = review.files.length;
  const cached = judge.cached || judge.summary.cached;

  return (
    <p className="mt-2 text-[12px] text-muted">
      {fileCount} {fileCount === 1 ? "file" : "files"} · {lineCount} lines · last turn{" "}
      {judge.ms === null ? "—" : `${judge.ms} ms`}
      {cached && (
        <>
          {" · "}
          <span data-cached="1" className="text-muted/70">
            from cache
          </span>
        </>
      )}
    </p>
  );
}
