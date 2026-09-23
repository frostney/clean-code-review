import {
  localhostAllowedHostnames,
  validateHostHeader,
  validateOriginHeader,
} from '@modelcontextprotocol/server';

import { jsonRpcError } from './request.js';

/**
 * Checks that run before auth: which host the request names, whether it
 * arrived over HTTPS, and which page sent it. The request URL cannot answer
 * any of them alone, since its host comes from the client's `Host` header.
 */

export type AllowedHosts = readonly string[] | 'any';

/** How to tell that a request arrived over HTTPS. */
export type HttpsPolicy = 'auto' | 'trusted-proxy' | 'off';

type Deployment = 'dev' | 'vercel' | 'other';

const SERVER_ERROR = -32_000;
const FORBIDDEN = 403;
const MISCONFIGURED = 500;

const LOOPBACK = localhostAllowedHostnames();

/** Read per request: a build can evaluate the channel without the runtime's environment. */
export function deployment(env: NodeJS.ProcessEnv = process.env): Deployment {
  if (
    env.EVE_DEV === '1' ||
    (env.VERCEL === '1' && env.VERCEL_ENV === 'development')
  ) {
    return 'dev';
  }

  return env.VERCEL === '1' ? 'vercel' : 'other';
}

function requestHost(request: Request): string {
  return request.headers.get('host') ?? new URL(request.url).host;
}

/**
 * Loopback under `eve dev` or `vercel dev`; any host on Vercel, whose edge
 * routes by `Host` to this deployment's own domains only; elsewhere, the
 * app's list, which is required.
 */
function hostList(
  configured: AllowedHosts | undefined,
  where: Deployment,
): AllowedHosts | null {
  if (configured !== undefined) {
    return configured;
  }
  if (where === 'dev') {
    return LOOPBACK;
  }

  return where === 'vercel' ? 'any' : null;
}

function checkHost(
  header: string,
  hosts: AllowedHosts,
): { ok: true; hostname: string } | { ok: false; message: string } {
  if (hosts !== 'any') {
    return validateHostHeader(header, [...hosts]);
  }
  try {
    return { hostname: new URL(`http://${header}`).hostname, ok: true };
  } catch {
    return { message: `Invalid Host header: ${header}`, ok: false };
  }
}

/** Hostnames as `validateHostHeader` compares them: lower case, no port, IPv6 in brackets. */
export function normalizeHostname(entry: string): string {
  let parsed: string;

  try {
    parsed = new URL(`http://${entry}`).hostname;
  } catch {
    throw new Error(`allowedHosts: "${entry}" is not a hostname.`);
  }
  if (parsed !== entry.toLowerCase()) {
    throw new Error(
      `allowedHosts: "${entry}" must be a bare hostname, without scheme, port or path.`,
    );
  }

  return parsed;
}

function refusal(message: string): Response {
  return jsonRpcError(FORBIDDEN, SERVER_ERROR, message);
}

function isHttps(
  request: Request,
  policy: HttpsPolicy,
  where: Deployment,
): boolean {
  if (policy === 'off') {
    return true;
  }
  const url = new URL(request.url);

  if (policy === 'trusted-proxy') {
    const forwarded = request.headers
      .get('x-forwarded-proto')
      ?.split(',')[0]
      ?.trim();

    return forwarded === 'https' || url.protocol === 'https:';
  }

  // Only Vercel's edge sets the scheme the function sees; elsewhere a
  // client-sent `X-Forwarded-Proto` can make the URL read https.
  return where === 'vercel' && url.protocol === 'https:';
}

export interface AdmissionPolicy {
  readonly allowedHosts?: AllowedHosts;
  readonly https: HttpsPolicy;
  readonly checkOrigin: boolean;
}

/** A refusal, or null when the request may go on to auth. */
export function admissionRefusal(
  request: Request,
  policy: AdmissionPolicy,
  env: NodeJS.ProcessEnv = process.env,
): Response | null {
  const where = deployment(env);
  const hosts = hostList(policy.allowedHosts, where);

  if (hosts === null) {
    return jsonRpcError(
      MISCONFIGURED,
      SERVER_ERROR,
      'This MCP endpoint has no allowedHosts for this deployment.',
    );
  }
  const host = checkHost(requestHost(request), hosts);

  if (!host.ok) {
    return refusal(host.message);
  }
  const loopback = LOOPBACK.includes(host.hostname);

  if (!(loopback || isHttps(request, policy.https, where))) {
    return refusal('HTTPS is required.');
  }
  if (!policy.checkOrigin) {
    return null;
  }
  const origin = validateOriginHeader(
    request.headers.get('origin'),
    hosts === 'any' ? [host.hostname] : [...hosts],
  );

  return origin.ok ? null : refusal(origin.message);
}
