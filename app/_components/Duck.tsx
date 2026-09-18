'use client';

import type { ReactNode } from 'react';

import { useReviewControls, useReviewView } from './ReviewProvider';

/**
 * The duck, in both of its sizes.
 *
 * There is one duck on this page and it is in two places: large above the
 * field while nothing is open, and small beside the field once a review is.
 * Only one of the two is ever rendered, and both wear the same
 * `view-transition-name`, which is what lets the browser treat them as the
 * same bird and animate one into the other instead of crossing them over.
 *
 * The image itself is handed in rather than imported, so `next/image` stays in
 * the server's bundle and out of this one.
 */
const SAME_DUCK = { viewTransitionName: 'duck' } as const;

/** The mascot on the landing view: nothing is open, so nothing to click. */
export function LandingDuck({ children }: { children: ReactNode }) {
  const { open } = useReviewView();
  if (open) {
    return null;
  }

  return (
    <div className="mt-4 mb-5 flex justify-center sm:mt-8 sm:mb-6">
      <span className="inline-flex" style={SAME_DUCK}>
        {children}
      </span>
    </div>
  );
}

/**
 * The mark beside the field in the code view, and the way back out of it. A
 * page with no title has nothing else that means "the start", and the duck is
 * already where a wordmark would be.
 */
export function HomeDuck({ children }: { children: ReactNode }) {
  const { open } = useReviewView();
  const { goHome } = useReviewControls();
  if (!open) {
    return null;
  }

  return (
    <button
      aria-label="Close this review and start again"
      className="inline-flex shrink-0 cursor-pointer items-center rounded-md"
      data-duck="home"
      onClick={goHome}
      style={SAME_DUCK}
      title="Start again"
      type="button"
    >
      {children}
    </button>
  );
}
