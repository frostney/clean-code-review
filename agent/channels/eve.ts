import {
  type AuthFn,
  ForbiddenError,
  localDev,
  none,
  vercelOidc,
} from 'eve/channels/auth';
import { eveChannel } from 'eve/channels/eve';

import {
  createThrottle,
  overSharedLimit,
  SESSION_CREATE_RULE,
} from '../lib/infra/rate-limit';

/**
 * Counted per address in this instance's memory, which Fluid Compute keeps
 * warm enough to catch a loop, and against the Firewall's shared counter
 * where its rule exists. The remaining bound is the global spend brake.
 *
 * A whole IPv6 /64 counts as one caller, which binds live traffic tighter
 * than a count per address: a host is handed the block and rotates in it.
 */
const SESSIONS_PER_WINDOW = 30;
const WINDOW_MS = 600_000;
const sessionsInThisInstance = createThrottle(SESSIONS_PER_WINDOW, WINDOW_MS);

function sessionCreationBrake(): AuthFn<Request> {
  return async (request) => {
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
    if (
      sessionsInThisInstance(ip) ||
      (await overSharedLimit(SESSION_CREATE_RULE, request.headers, ip))
    ) {
      throw new ForbiddenError({
        message:
          'Too many new sessions from this address. Try again in a few minutes.',
      });
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
