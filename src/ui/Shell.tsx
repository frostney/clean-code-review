import { Hero } from '@/src/landing/Hero';
import type { PullRequestAddress } from '@/src/pull-request/address';
import type { PullRequestPayload } from '@/src/pull-request/pull-request';
import { ReviewProvider } from '@/src/review/ReviewProvider';

import { Footer } from './Footer';
import { Stage } from './Stage';

/**
 * The page, once for both routes that render it.
 *
 * `/` renders it with nothing: the landing view, where the duck is large and
 * the field is empty. `/owner/repo/pull/123` renders the same tree with the
 * pull request already fetched, so a permalink is a review in the first paint
 * rather than a fetch that starts after the JavaScript arrives.
 *
 * Everything that does not change — the footer, the labels, the hints — is
 * rendered here, on the server, and handed to the provider as children, so
 * none of it is ever sent to the browser as JavaScript.
 */
export function Shell({
  address,
  error,
  pullRequest,
}: {
  address?: PullRequestAddress;
  /** Why the pull request the URL named never opened. */
  error?: string | null;
  pullRequest?: PullRequestPayload | null;
}) {
  return (
    <ReviewProvider
      initialAddress={address}
      initialError={error}
      initialPullRequest={pullRequest}
    >
      {/* The theme switch sits over the top right corner of every page (the
          root layout puts it there). Below `lg` the code view is the one page
          with something in that corner, since the address takes the whole
          line, so it starts the page one switch lower: 40px, the switch's own
          height, which is the least that keeps the two from touching without
          taking any width from the address. The home duck's presence is how
          the markup already says a review is open, as in `Hero`. */}
      <div className="mx-auto max-w-[1280px] px-4 py-5 max-lg:has-[[data-duck=home]]:pt-10">
        <main>
          {/* The page's own name. On screen it is the browser tab and the
              first field's placeholder; a document still needs a heading. */}
          <Hero />
          <Stage />
        </main>
        <Footer />
      </div>
    </ReviewProvider>
  );
}
