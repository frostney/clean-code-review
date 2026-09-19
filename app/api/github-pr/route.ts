import { fetchPullRequest } from '@/agent/lib/github/github';
import { callerIp, throttled } from '@/src/pull-request/throttle';

export const dynamic = 'force-dynamic';

const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_MANY = 429;
const HTTP_BAD_GATEWAY = 502;

const CACHE_SECONDS = 60;

function statusFor(message: string): number {
  if (/not a GitHub|not found|too large/.test(message)) {
    return HTTP_BAD_REQUEST;
  }
  return /rate limit/.test(message) ? HTTP_TOO_MANY : HTTP_BAD_GATEWAY;
}

/**
 * GET /api/github-pr?url=… for scripts and other callers; the page uses the
 * server action instead (it renders the description on the server).
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
