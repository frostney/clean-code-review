'use client';

import { type ReactNode, ViewTransition } from 'react';

/**
 * For React-driven navigations (to `/faq` and back), which only name what is
 * inside a `<ViewTransition>`; the page's own review transitions use the inline
 * name in `Duck.tsx`. `default="none"` keeps it out of every other transition,
 * and `share` is explicit because `none` alone would stop the morph too.
 * Imports nothing of the review so `/faq` does not download it.
 */
export function DuckTransition({ children }: { children: ReactNode }) {
  return (
    <ViewTransition default="none" name="duck" share="auto">
      {children}
    </ViewTransition>
  );
}
