'use client';

import { Paste } from '@/src/landing/Paste';
import { ReviewBody } from '@/src/review/ReviewBody';
import { useReviewView } from '@/src/review/ReviewProvider';

/**
 * The review's room, held open from the press that asks for one: a screen of
 * it, so the footer has already left a phone's screen and the diff arriving
 * moves nothing. It is empty until then, deliberately — anything drawn in it
 * would be pushed down by the pull request's title and description, and that
 * push is a layout shift. The word for the wait is in the hero, above them.
 */
const ROOM = 'min-h-svh';

// The review renders its own paste dialog; the landing view gets it here.
export function Stage() {
  const { committed, open } = useReviewView();

  if (!committed) {
    return <Paste />;
  }

  return <div className={ROOM}>{open ? <ReviewBody /> : null}</div>;
}
