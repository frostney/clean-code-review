"use client";

import { PullRequestBodyToggle } from "./PullRequestBodyToggle";
import { useReviewView } from "./ReviewProvider";

/**
 * What is being reviewed, when it came from a pull request: its title, linked
 * back to GitHub, and the author's description under it. The description is
 * the node the server action rendered — this only decides whether it is on
 * screen and folds it.
 */
export function PullRequestSummary() {
  const { review } = useReviewView();
  const pr = review.pr;
  if (!pr) return null;

  return (
    <>
      <p className="mt-3 min-w-0 text-[13px]">
        {pr.url ? (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            data-pr-title
            className="font-semibold text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
          >
            {pr.title}
          </a>
        ) : (
          <span data-pr-title className="font-semibold text-ink">
            {pr.title}
          </span>
        )}
      </p>
      {pr.body ? <PullRequestBodyToggle>{pr.body}</PullRequestBodyToggle> : null}
    </>
  );
}
