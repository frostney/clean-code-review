import { fetchPullRequest } from '@/agent/lib/github';
import { callerIp, throttled } from '@/lib/throttle';

export const dynamic = 'force-dynamic';

/** What each kind of failure is answered with. */
const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_MANY = 429;
const HTTP_BAD_GATEWAY = 502;

/** A pull request does not change often enough to fetch twice in a minute. */
const CACHE_SECONDS = 60;

/** The reason a request was refused, as a status code. */
function statusFor(message: string): number {
  if (/not a GitHub|not found|too large/.test(message)) {
    return HTTP_BAD_REQUEST;
  }
  return /rate limit/.test(message) ? HTTP_TOO_MANY : HTTP_BAD_GATEWAY;
}

/**
 * GET /api/github-pr?url=https://github.com/owner/repo/pull/123
 * Returns { url, title, body, diff, changedFiles } for a public pull request.
 *
 * The page itself no longer calls this — it uses the `openPullRequest` server
 * action, which renders the description on the server — but scripts and other
 * callers still do, so it stays, sharing the action's rate limit.
 */
export async function GET(request: Request) {
  if (throttled(callerIp(request.headers))) {
    return Response.json(
      {
        error:
          'Too many pull requests fetched from this address. Try again in a few minutes.',
      },
      { status: HTTP_TOO_MANY },
    );
  }
  const url = new URL(request.url).searchParams.get('url') ?? '';
  try {
    const pr = await fetchPullRequest(url);
    return Response.json(pr, {
      headers: { 'cache-control': `public, max-age=${CACHE_SECONDS}` },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Could not fetch that pull request.';
    return Response.json({ error: message }, { status: statusFor(message) });
  }
}
