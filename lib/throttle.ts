/**
 * Best-effort brakes on how often one address may do something expensive.
 *
 * Each brake is its own counter. The page's GitHub brake is shared by the route
 * handler and the page's own server action, so that both ways in count against
 * the same window; the MCP endpoint has a brake of its own, because a call
 * there fetches, judges and writes a whole review, and its share is smaller.
 *
 * This instance's memory only: a serverless deploy runs many of these and none
 * of them agree, which is why it is a brake and not a quota.
 */
/** One address's share of a window. Exported because /privacy says it out loud. */
export const REQUESTS_PER_WINDOW = 20;
/** Ten minutes: the window a caller's share is counted over. */
export const WINDOW_MS = 600_000;
/** How many addresses a brake holds before it is thrown away wholesale. */
const MAX_TRACKED_ADDRESSES = 10_000;

/**
 * A brake that lets one address through `limit` times per `windowMs`. The
 * returned function counts the call it lets through and answers true, without
 * counting, when this address has already had its share.
 */
export function createThrottle(
  limit: number,
  windowMs: number,
): (ip: string | null | undefined) => boolean {
  const seen = new Map<string, number[]>();
  return (ip) => {
    if (!ip) {
      return false;
    }
    const now = Date.now();
    const recent = (seen.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      return true;
    }
    recent.push(now);
    seen.set(ip, recent);
    if (seen.size > MAX_TRACKED_ADDRESSES) {
      seen.clear();
    }
    return false;
  };
}

/** True when this address has already had its share of GitHub in the last ten minutes. */
export const throttled = createThrottle(REQUESTS_PER_WINDOW, WINDOW_MS);

/** The caller's address as the platform reports it, or null behind no proxy. */
export function callerIp(headers: Headers): string | null {
  return (
    headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ||
    headers.get('x-real-ip')
  );
}
