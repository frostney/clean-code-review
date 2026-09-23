import {
  RECENT_REFRESH_SECONDS,
  recentPullRequests,
} from '@/agent/lib/github/recent';
import { recentPullRequestsThrottled } from '@/src/landing/recent-throttle';

export const dynamic = 'force-dynamic';

const HTTP_TOO_MANY = 429;

/**
 * GET /api/recent-prs for the landing page's live example chips.
 *
 * Its own throttle and Firewall rule rather than `/api/github-pr`'s: sharing
 * that window would let a few page loads refuse a reader the pull request they
 * pasted. An empty list is an answer, not an error — GitHub being quiet, out
 * of budget, or unreachable means the row does not render, and nothing here
 * has failed. Only a refused caller gets a status.
 */
export async function GET(request: Request) {
  if (await recentPullRequestsThrottled(request.headers)) {
    return Response.json(
      {
        error:
          'Too many requests from this address. Try again in a few minutes.',
      },
      { headers: { 'cache-control': 'no-store' }, status: HTTP_TOO_MANY },
    );
  }
  const pullRequests = await recentPullRequests();

  return Response.json(
    { pullRequests },
    {
      headers: {
        // `s-maxage` so the CDN holds the one shared answer and every reader
        // behind it is free; `stale-while-revalidate` so the reader who
        // arrives at expiry is served the old list rather than waiting for the
        // walk. Both are per region and best effort.
        'cache-control': `public, max-age=${RECENT_REFRESH_SECONDS}, s-maxage=${RECENT_REFRESH_SECONDS}, stale-while-revalidate=${RECENT_REFRESH_SECONDS}`,
      },
    },
  );
}
