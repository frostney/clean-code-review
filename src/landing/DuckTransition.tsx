'use client';

import { type ReactNode, ViewTransition } from 'react';

/**
 * The same bird again, for the transitions React starts rather than this page.
 *
 * Opening and closing a review is a synchronous update inside a transition
 * this page starts itself (`src/landing/view-transition.ts`), and React leaves those
 * alone, so the inline name `Duck.tsx` puts on the bird is what the browser
 * pairs there. Following a link to `/faq` and back is a navigation, which
 * React runs as a transition of its own, and there it names only what sits
 * inside a `<ViewTransition>`: this is that, under the same name as the
 * questions page's duck.
 *
 * `default="none"` is what keeps this boundary out of every other transition
 * on the page, and `share` is spelled out because without it `none` would
 * stop the morph too. Both ducks are never mounted at once, so the name is
 * only ever claimed once.
 *
 * A file of its own, importing nothing of the review: `/faq` wears this too,
 * and a page of prose has no business downloading the review to get a duck.
 */
export function DuckTransition({ children }: { children: ReactNode }) {
  return (
    <ViewTransition default="none" name="duck" share="auto">
      {children}
    </ViewTransition>
  );
}
