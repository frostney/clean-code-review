'use client';

import { Paste } from '@/src/landing/Paste';
import { ReviewBody } from '@/src/review/ReviewBody';
import { useReviewView } from '@/src/review/ReviewProvider';

// The review renders its own paste dialog; the landing view gets it here.
export function Stage() {
  const { open } = useReviewView();

  if (open) {
    return <ReviewBody />;
  }

  return <Paste />;
}
