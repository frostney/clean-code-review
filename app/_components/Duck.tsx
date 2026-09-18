'use client';

import { type ReactNode, ViewTransition } from 'react';

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

/**
 * The same bird again, for the transitions React starts rather than this page.
 *
 * Opening and closing a review is a synchronous update inside a transition
 * this page starts itself (`lib/view-transition.ts`), and React leaves those
 * alone, so the inline name above is what the browser pairs there. Following
 * a link to `/faq` and back is a navigation, which React runs as a transition
 * of its own, and there it names only what sits inside a `<ViewTransition>`:
 * this is that, under the same name as the questions page's duck.
 *
 * `default="none"` is what keeps this boundary out of every other transition
 * on the page, and `share` is spelled out because without it `none` would
 * stop the morph too. Both ducks are never mounted at once, so the name is
 * only ever claimed once.
 */
export function DuckTransition({ children }: { children: ReactNode }) {
  return (
    <ViewTransition default="none" name="duck" share="auto">
      {children}
    </ViewTransition>
  );
}

/**
 * The mascot on the landing view, and whatever it is saying.
 *
 * `aside` is a slot beside the bird rather than part of it: the duck keeps the
 * `view-transition-name`, so anything inside that span is snapshotted and
 * morphed with it when a review opens, and a speech bubble is not the duck.
 * The column is what puts the bubble under the duck on a phone, where there is
 * no room beside it; from `lg` up the bubble takes itself out of the flow and
 * stands to the right, which is why the duck does not move when it appears.
 */
export function LandingDuck({
  aside,
  children,
}: {
  /** Rendered after the duck, in the same positioning context. */
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
