import type { PullRequestAddress } from '@/lib/address';
import type { PullRequestPayload } from '@/lib/pull-request';

import { Footer } from './Footer';
import { Hero } from './Hero';
import { ReviewProvider } from './ReviewProvider';
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
      <div className="mx-auto max-w-[1280px] px-4 py-5">
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
