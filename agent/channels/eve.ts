import {
  type AuthFn,
  ForbiddenError,
  localDev,
  none,
  vercelOidc,
} from 'eve/channels/auth';
import { eveChannel } from 'eve/channels/eve';

import {
  SESSION_WINDOW_MS,
  SESSIONS_PER_WINDOW,
} from '../lib/infra/session-facts';

/**
 * Best effort: counted per address in this instance's memory, which Fluid
 * Compute keeps warm enough to catch a loop. The real bounds are the global
 * spend brake and the Vercel Firewall.
 */
const MAX_TRACKED_ADDRESSES = 10_000;
const sessionStartsByAddress = new Map<string, number[]>();

function sessionCreationBrake(): AuthFn<Request> {
  return (request) => {
    const url = new URL(request.url);
    const isCreate =
      request.method === 'POST' && /\/eve\/v1\/session\/?$/.test(url.pathname);
    if (!isCreate) {
      return null;
    }
    // x-vercel-forwarded-for comes from the connection itself; a client can
    // prefix x-forwarded-for, so only its last hop is trusted.
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
    if (!ip) {
      return null;
    }
    const now = Date.now();
    const recent = (sessionStartsByAddress.get(ip) ?? []).filter(
      (t) => now - t < SESSION_WINDOW_MS,
    );
    if (recent.length >= SESSIONS_PER_WINDOW) {
      throw new ForbiddenError({
        message:
          'Too many new sessions from this address. Try again in a few minutes.',
      });
    }
    recent.push(now);
    sessionStartsByAddress.set(ip, recent);
    if (sessionStartsByAddress.size > MAX_TRACKED_ADDRESSES) {
      sessionStartsByAddress.clear();
    }
    return null; // Not an identity: fall through to the real auth entries.
  };
}

/**
 * Public demo with no accounts. eve requires `none()` to be explicit before it
 * serves anonymous production browser traffic.
 */
export default eveChannel({
  // Order matters: authenticated callers (OIDC, local TUI) skip the brake.
  auth: [vercelOidc(), localDev(), sessionCreationBrake(), none()],
});
