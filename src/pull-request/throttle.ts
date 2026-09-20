import {
  createThrottle,
  GITHUB_FETCH_RULE,
  overSharedLimit,
} from '@/agent/lib/infra/rate-limit';

/** Exported for the /privacy page. */
export const GITHUB_FETCHES_PER_WINDOW = 20;
export const GITHUB_FETCH_WINDOW_MS = 600_000;

/** Shared by the server action and `/api/github-pr`, so both count one window. */
const inThisInstance = createThrottle(
  GITHUB_FETCHES_PER_WINDOW,
  GITHUB_FETCH_WINDOW_MS,
);

/**
 * The in-process brake counts first: it costs nothing, and a caller it
 * already refuses need not be counted by the Firewall as well.
 */
export async function githubFetchThrottled(headers: Headers): Promise<boolean> {
  const ip = callerIp(headers);
  return (
    inThisInstance(ip) ||
    (await overSharedLimit(GITHUB_FETCH_RULE, headers, ip))
  );
}

export function callerIp(headers: Headers): string | null {
  return (
    headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ||
    headers.get('x-real-ip')
  );
}
