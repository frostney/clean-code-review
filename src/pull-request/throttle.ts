/**
 * Per-instance memory only: serverless instances do not share it, which is
 * why it is a best-effort brake and not a quota.
 */
/** Exported for the /privacy page. */
export const REQUESTS_PER_WINDOW = 20;
export const WINDOW_MS = 600_000;
/** Least recently seen addresses are evicted past this. */
const MAX_TRACKED_ADDRESSES = 10_000;

// Vercel always sets the address; any request without one shares one bucket
// rather than passing unseen.
const UNKNOWN = 'unknown';

const IPV6_GROUPS = 8;
const PREFIX_GROUPS = 4;
const IPV4_OCTETS = 4;
const BYTE = 256;
const HEX = 16;

/** Expands `::` and a trailing dotted IPv4; null when not IPv6. */
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

function embeddedIpv4(group: string): string[] {
  const octets = group.split('.');
  if (octets.length !== IPV4_OCTETS) {
    return [group];
  }
  const [a, b, c, d] = octets.map(Number);
  const pair = (x: number, y: number) => (x * BYTE + y).toString(HEX);
  return [pair(a, b), pair(c, d)];
}

// IPv6 counts per /64: a host is handed a whole /64 and can rotate within it.
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

/** Returns true (without counting) once `limit` calls fell within `windowMs`. */
export function createThrottle(
  limit: number,
  windowMs: number,
): (ip: string | null | undefined) => boolean {
  // LRU via Map insertion order: every counted call re-inserts its bucket.
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

/** Shared by the server action and `/api/github-pr`, so both count one window. */
export const throttled = createThrottle(REQUESTS_PER_WINDOW, WINDOW_MS);

export function callerIp(headers: Headers): string | null {
  return (
    headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ||
    headers.get('x-real-ip')
  );
}
