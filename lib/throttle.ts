/**
 * Best-effort brake on how often one address may pull a pull request from
 * GitHub, shared by the route handler and the page's own server action so that
 * both ways in count against the same window.
 *
 * This instance's memory only: a serverless deploy runs many of these and none
 * of them agree, which is why it is a brake and not a quota.
 */
const REQUESTS_PER_WINDOW = 20;
/** Ten minutes: the window a caller's share is counted over. */
const WINDOW_MS = 600_000;
/** How many addresses the map holds before it is thrown away wholesale. */
const MAX_TRACKED_ADDRESSES = 10_000;
const seen = new Map<string, number[]>();

/** True when this address has already had its share of the last ten minutes. */
export function throttled(ip: string | null | undefined): boolean {
  if (!ip) {
    return false;
  }
  const now = Date.now();
  const recent = (seen.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= REQUESTS_PER_WINDOW) {
    return true;
  }
  recent.push(now);
  seen.set(ip, recent);
  if (seen.size > MAX_TRACKED_ADDRESSES) {
    seen.clear();
  }
  return false;
}

/** The caller's address as the platform reports it, or null behind no proxy. */
export function callerIp(headers: Headers): string | null {
  return (
    headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ||
    headers.get('x-real-ip')
  );
}
