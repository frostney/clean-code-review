/**
 * The identity a rate limit counts against. It lives here because the eve
 * channel and the app both bucket callers and `agent/` may not import `src/`.
 */

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
export function addressBucket(ip: string | null | undefined): string {
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
