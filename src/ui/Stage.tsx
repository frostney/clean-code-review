'use client';

import { Paste } from '@/src/landing/Paste';
import { ReviewBody } from '@/src/review/ReviewBody';
import { useReviewView } from '@/src/review/ReviewProvider';

import { Notice } from './Notice';

/**
 * Everything under the header, which is one of two pages.
 *
 * With a review open it is the review, and nothing else: someone reading a
 * judgment of their own code is past being introduced to the page. With
 * nothing open it is the landing view, which is the ways in.
 *
 * The paste dialog and the notice that a pull request did not open belong to
 * both views, and the review carries its own — so on the landing view they are
 * rendered here instead, where they are the only things that can happen.
 *
 * The landing branch is a list, and it is meant to grow: anything that belongs
 * on the door rather than in the review goes in it, below the paste dialog,
 * and this component's only business is which of the two branches is on
 * screen.
 */
export function Stage() {
  const { open, prError } = useReviewView();

  if (open) {
    return <ReviewBody />;
  }

  return (
    <>
      {prError ? <Notice data-pr="error">{prError}</Notice> : null}
      <Paste />
    </>
  );
}
