'use client';

import { useReviewView } from './ReviewProvider';

/** What the last turn cost in tokens, once there has been one. */
export function TokenCount() {
  const { judge } = useReviewView();
  if (!judge.usage) {
    return null;
  }

  return (
    <span>
      {judge.usage.inputTokens}&rarr;{judge.usage.outputTokens} tokens (last
      turn)
    </span>
  );
}
