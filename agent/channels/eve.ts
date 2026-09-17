import {
  type AuthFn,
  ForbiddenError,
  localDev,
  none,
  vercelOidc,
} from 'eve/channels/auth';
import { eveChannel } from 'eve/channels/eve';

/**
 * Best-effort brake for a public demo: at most SESSIONS_PER_WINDOW new
 * sessions per client address per window, counted in this instance's memory.
 * Fluid Compute keeps an instance warm across requests, so this catches a
 * loop hammering session creation; it is not a substitute for an AI Gateway
 * spend cap or a Vercel Firewall rate-limit rule, which are the real bounds.
 */
const SESSIONS_PER_WINDOW = 30;
/** Ten minutes: the window new sessions are counted over. */
const WINDOW_MS = 600_000;
/** How many addresses the map holds before it is thrown away wholesale. */
const MAX_TRACKED_ADDRESSES = 10_000;
const created = new Map<string, number[]>();

function sessionCreationBrake(): AuthFn<Request> {
  return (request) => {
    const url = new URL(request.url);
    const isCreate =
      request.method === 'POST' && /\/eve\/v1\/session\/?$/.test(url.pathname);
    if (!isCreate) {
      return null;
    }
    // Vercel sets x-vercel-forwarded-for from the connection itself; a plain
    // x-forwarded-for can be prefixed by the client, so take its last hop.
    const forwarded =
      request.headers
        .get('x-forwarded-for')
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    const ip =
      request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      forwarded.at(-1);
    // Without an address there is nothing fair to count against.
    if (!ip) {
      return null;
    }
    const now = Date.now();
    const recent = (created.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= SESSIONS_PER_WINDOW) {
      throw new ForbiddenError({
        message:
          'Too many new sessions from this address. Try again in a few minutes.',
      });
    }
    recent.push(now);
    created.set(ip, recent);
    if (created.size > MAX_TRACKED_ADDRESSES) {
      created.clear();
    }
    return null; // Not an identity: fall through to the real auth entries.
  };
}

/**
 * This is a public demo: the browser talks to the agent directly, with no
 * account in front of it. `none()` admits anonymous traffic explicitly, which
 * eve requires before it serves production browser requests. Anyone can
 * create sessions; the per-session cost cap in agent.ts bounds one tab, and
 * the brake above slows a loop. Before promoting the URL, add an AI Gateway
 * spend cap or a Vercel Firewall rate limit on POST /eve/v1/session.
 */
export default eveChannel({
  // Authenticated callers (Vercel OIDC, the local TUI) skip the brake; only
  // anonymous traffic is counted.
  auth: [vercelOidc(), localDev(), sessionCreationBrake(), none()],
});
