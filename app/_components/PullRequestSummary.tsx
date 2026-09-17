'use client';

import { PullRequestBodyToggle } from './PullRequestBodyToggle';
import { useReviewView } from './ReviewProvider';

/**
 * What is being reviewed, when it came from a pull request: its title, linked
 * back to GitHub, and the author's description under it. The description is
 * the node the server action rendered — this only decides whether it is on
 * screen and folds it.
 */
export function PullRequestSummary() {
  const { review } = useReviewView();
  const pr = review.pr;
  if (!pr) {
    return null;
  }
  // `ReactNode` includes a promise, which is not something to test for
  // truthiness; the description is either a node the server rendered or not one.
  const hasBody = pr.body !== undefined && pr.body !== null;

  return (
    <>
      <p className="mt-3 min-w-0 text-[13px]">
        {pr.url ? (
          <a
            className="inline-flex min-h-10 items-center font-semibold text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent lg:min-h-0"
            data-pr-title={true}
            href={pr.url}
            rel="noreferrer"
            target="_blank"
          >
            {pr.title}
          </a>
        ) : (
          <span className="font-semibold text-ink" data-pr-title={true}>
            {pr.title}
          </span>
        )}
      </p>
      {hasBody ? (
        <PullRequestBodyToggle>{pr.body}</PullRequestBodyToggle>
      ) : null}
    </>
  );
}
