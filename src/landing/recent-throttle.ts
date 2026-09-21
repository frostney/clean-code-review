import {
  createThrottle,
  overSharedLimit,
  RECENT_PRS_RULE,
} from '@/agent/lib/infra/rate-limit';
import { callerIp } from '@/src/pull-request/throttle';

/**
 * Higher than the GitHub-fetch window, and counted apart from it: this answer
 * is one shared, cached list that costs GitHub nothing per request, and a
 * reader who opened the landing page a few times must not then be refused the
 * pull request they actually pasted.
 */
const RECENT_PRS_PER_WINDOW = 60;
const RECENT_PRS_WINDOW_MS = 600_000;

const inThisInstance = createThrottle(
  RECENT_PRS_PER_WINDOW,
  RECENT_PRS_WINDOW_MS,
);

/**
 * Vercel's CDN keys a function response on the query string, so a caller can
 * walk past the cached entry with `?n=…` and reach the function every time.
 * The in-process brake counts first: it costs nothing, and a caller it already
 * refuses need not be counted by the Firewall as well.
 */
export async function recentPullRequestsThrottled(
  headers: Headers,
): Promise<boolean> {
  const ip = callerIp(headers);

  return (
    inThisInstance(ip) || (await overSharedLimit(RECENT_PRS_RULE, headers, ip))
  );
}
