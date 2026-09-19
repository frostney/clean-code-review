import { Hero } from '@/src/landing/Hero';
import type { PullRequestAddress } from '@/src/pull-request/address';
import type { PullRequestPayload } from '@/src/pull-request/pull-request';
import { ReviewProvider } from '@/src/review/ReviewProvider';

import { Footer } from './Footer';
import { Stage } from './Stage';

// Rendered by `/` and by the permalink route (with the pull request already
// fetched). Static parts are server children of the provider, never client JS.
export function Shell({
  address,
  error,
  pullRequest,
}: {
  address?: PullRequestAddress;
  error?: string | null;
  pullRequest?: PullRequestPayload | null;
}) {
  return (
    <ReviewProvider
      initialAddress={address}
      initialError={error}
      initialPullRequest={pullRequest}
    >
      {/* Below `lg` the code view shares the top-right corner with the theme
          switch, so its top padding grows to 40px, the switch's height. */}
      <div className="mx-auto max-w-[1280px] px-4 py-5 max-lg:has-[[data-duck=home]]:pt-10">
        <main>
          <Hero />
          <Stage />
        </main>
        <Footer />
      </div>
    </ReviewProvider>
  );
}
