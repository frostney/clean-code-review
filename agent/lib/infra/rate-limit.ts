/**
 * Two bounds on the same count. `createThrottle` is per-instance memory:
 * serverless instances do not share it, which is why it is a best-effort
 * brake and not a quota. `overSharedLimit` asks the Vercel Firewall, whose
 * counters hold across instances — but only where the matching rule exists,
 * so a call site keeps its throttle as the bound that is always there and
 * the Firewall can only refuse more, never less.
 *
 * `checkRateLimit` reaches the Firewall over HTTP and needs a rule carrying
 * the same Rate Limit ID; without one it answers `not-found` and warns on
 * every call, so a rule that answers that way, and one that fails to answer
 * at all, are both left alone for a while.
 * Only the production deployment is asked: a preview's own host sits behind
 * Deployment Protection, and off Vercel the SDK returns an allowed answer
 * that cannot be told from a real one.
 */
import { checkRateLimit } from '@vercel/firewall';

import { addressBucket } from './address';

/**
 * Rate Limit IDs. Each needs a `@vercel/firewall` rule on the project's
 * Firewall carrying the same limit and window as the throttle beside it, or
 * the two bounds disagree: 20 per 10 minutes for GitHub fetches,
 * 30 per 10 minutes for session creation.
 */
export const GITHUB_FETCH_RULE = 'github-fetch';
export const SESSION_CREATE_RULE = 'session-create';

const RULES_DEPLOYED_TO = 'production';

/** Least recently seen addresses are evicted past this. */
const MAX_TRACKED_ADDRESSES = 10_000;

/** Returns true (without counting) once `limit` calls fell within `windowMs`. */
export function createThrottle(
  limit: number,
  windowMs: number,
): (ip: string | null | undefined) => boolean {
  // LRU via Map insertion order: every counted call re-inserts its bucket.
  const seen = new Map<string, number[]>();

  return (ip) => {
    const bucket = addressBucket(ip);
    const now = Date.now();
    const recent = (seen.get(bucket) ?? []).filter((t) => now - t < windowMs);

    if (recent.length >= limit) {
      return true;
    }
    recent.push(now);
    seen.delete(bucket);
    seen.set(bucket, recent);
    for (const oldest of seen.keys()) {
      if (seen.size <= MAX_TRACKED_ADDRESSES) {
        break;
      }
      seen.delete(oldest);
    }

    return false;
  };
}

/**
 * Both waits are finite. Rules are published from the dashboard or the CLI
 * rather than with a deploy, so a rule that is missing now can appear at any
 * time and an instance that gave up on it for good would never find out; an
 * instance that gave up on a Firewall that merely failed to answer would
 * leave its throttle as the only bound for the rest of its life. A rule that
 * answers `not-found` is only asked far less often than one that failed.
 */
export const RETRY_AFTER_NOT_FOUND_MS = 3_600_000;
export const RETRY_AFTER_FAILURE_MS = 60_000;

/** The clock time each rule may be asked again. */
const silentUntil = new Map<string, number>();

function stopAsking(rule: string, until: number, why: string): false {
  silentUntil.set(rule, until);
  console.warn(
    `[rate-limit] The Firewall rule "${rule}" ${why}; the per-instance throttle is the only bound on this instance.`,
  );

  return false;
}

/**
 * True when the Firewall counts this address over the rule's limit. False
 * whenever the Firewall has no answer to give, leaving the caller's own
 * throttle as the bound.
 */
export async function overSharedLimit(
  rule: string,
  headers: Headers,
  ip: string | null | undefined,
): Promise<boolean> {
  if (
    process.env.VERCEL_ENV !== RULES_DEPLOYED_TO ||
    Date.now() < (silentUntil.get(rule) ?? 0)
  ) {
    return false;
  }
  try {
    // Not the SDK's default key, which is the raw client IP: that would give
    // every address in a caller's /64 its own bucket.
    const { error, rateLimited } = await checkRateLimit(rule, {
      headers,
      rateLimitKey: addressBucket(ip),
    });

    return error === 'not-found'
      ? stopAsking(
          rule,
          Date.now() + RETRY_AFTER_NOT_FOUND_MS,
          'is not configured',
        )
      : rateLimited;
  } catch (err) {
    return stopAsking(
      rule,
      Date.now() + RETRY_AFTER_FAILURE_MS,
      `could not be reached (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
