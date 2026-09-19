'use client';

import type { ReactNode } from 'react';

import { useReviewControls, useReviewView } from '@/src/review/ReviewProvider';

import { DuckTransition } from './DuckTransition';

/**
 * Both ducks share one `view-transition-name`, and only one is ever rendered,
 * so the browser morphs one into the other.
 */
const SAME_DUCK = { viewTransitionName: 'duck' } as const;

/**
 * `aside` sits outside the named span: anything inside it would be snapshotted
 * and morphed with the duck. From `lg` the bubble leaves the flow, so the duck
 * does not move when it appears.
 */
export function LandingDuck({
  aside,
  children,
}: {
  aside?: ReactNode;
  children: ReactNode;
}) {
  const { open } = useReviewView();
  if (open) {
    return null;
  }

  return (
    <div className="relative mt-4 mb-5 flex flex-col items-center sm:mt-8 sm:mb-6">
      <DuckTransition>
        <span className="inline-flex" style={SAME_DUCK}>
          {children}
        </span>
      </DuckTransition>
      {aside}
    </div>
  );
}

// The page has no title, so the duck is the way back to the start.
export function HomeDuck({ children }: { children: ReactNode }) {
  const { open } = useReviewView();
  const { goHome } = useReviewControls();
  if (!open) {
    return null;
  }

  return (
    <DuckTransition>
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
    </DuckTransition>
  );
}
