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
/** How many addresses a brake holds before the least recently seen are let go. */
const MAX_TRACKED_ADDRESSES = 10_000;

/**
 * Where a request with no address is counted: all of them together, in one
 * share. On Vercel the platform always sets the address, so this is only a
 * request that reached the function some other way, and such requests share
 * one brake rather than passing every brake unseen.
 */
const UNKNOWN = 'unknown';

/** An IPv6 address has eight groups; a /64 is the first four. */
const IPV6_GROUPS = 8;
const PREFIX_GROUPS = 4;
/** An IPv4 address has four octets, and two of them make one IPv6 group. */
const IPV4_OCTETS = 4;
const BYTE = 256;
const HEX = 16;

/**
 * The eight groups of an IPv6 address, or null when it is not one. `::`
 * stands for as many zero groups as are missing, and an IPv4 address written
 * at the end fills the last two.
 */
function ipv6Groups(address: string): string[] | null {
  const [head, tail, extra] = address.split('::');
  if (extra !== undefined) {
    return null;
  }
  const groups = (part: string | undefined) =>
    part ? part.split(':').flatMap(embeddedIpv4) : [];
  const front = groups(head);
  const back = groups(tail);
  const missing = IPV6_GROUPS - front.length - back.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) {
    return null;
  }
  const all = [...front, ...Array<string>(missing).fill('0'), ...back];
  return all.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? all : null;
}

/** One group as written, or the two groups a trailing dotted IPv4 address stands for. */
function embeddedIpv4(group: string): string[] {
  const octets = group.split('.');
  if (octets.length !== IPV4_OCTETS) {
    return [group];
  }
  const [a, b, c, d] = octets.map(Number);
  const pair = (x: number, y: number) => (x * BYTE + y).toString(HEX);
  return [pair(a, b), pair(c, d)];
}

/**
 * What a brake counts one caller as. An IPv6 host is handed a whole /64, and
 * can move within it at will, so an IPv6 address counts as its /64; an IPv4
 * address, or an IPv4 address written as IPv6, counts as itself.
 */
function bucketOf(ip: string | null | undefined): string {
  const address = ip
    ?.trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '');
  if (!address) {
    return UNKNOWN;
  }
  if (!address.includes(':')) {
    return address;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) {
    return mapped[1];
  }
  const groups = ipv6Groups(address);
  return groups
    ? `${groups
        .slice(0, PREFIX_GROUPS)
        .map((g) => g.replace(/^0+(?=.)/, ''))
        .join(':')}::/64`
    : address;
}

/**
 * A brake that lets one address through `limit` times per `windowMs`. The
 * returned function counts the call it lets through and answers true, without
 * counting, when this address has already had its share. Requests with no
 * address share one bucket.
 */
export function createThrottle(
  limit: number,
  windowMs: number,
): (ip: string | null | undefined) => boolean {
  // Kept in order of last use: a Map iterates in insertion order, and every
  // counted call moves its bucket to the end.
  const seen = new Map<string, number[]>();
  return (ip) => {
    const bucket = bucketOf(ip);
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

/** True when this address has already had its share of GitHub in the last ten minutes. */
export const throttled = createThrottle(REQUESTS_PER_WINDOW, WINDOW_MS);

/** The caller's address as the platform reports it, or null behind no proxy. Counted by `bucketOf`. */
export function callerIp(headers: Headers): string | null {
  return (
    headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ||
    headers.get('x-real-ip')
  );
}
