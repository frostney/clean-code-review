'use client';

import type { ReactNode } from 'react';

import { Notice } from './Notice';
import { Paste } from './Paste';
import { ReviewBody } from './ReviewBody';
import { useReviewView } from './ReviewProvider';

/**
 * Everything under the header, which is one of two pages.
 *
 * With a review open it is the review, and the questions are not on the page
 * at all — someone reading a judgment of their own code is past asking what
 * this is. With nothing open it is the questions, which is why they are handed
 * in as a node: they are rendered on the server, in the initial HTML of `/`,
 * where a crawler and the `FAQPage` data beside them can find them. Hiding
 * them is this component's business; writing them is not.
 *
 * The paste dialog and the notice that a pull request did not open belong to
 * both views, and the review carries its own — so on the landing view they are
 * rendered here instead, where they are the only things that can happen.
 */
export function Stage({ questions }: { questions: ReactNode }) {
  const { open, prError } = useReviewView();

  if (open) {
    return <ReviewBody />;
  }

  return (
    <>
      {prError ? <Notice data-pr="error">{prError}</Notice> : null}
      <Paste />
      {questions}
    </>
  );
}
