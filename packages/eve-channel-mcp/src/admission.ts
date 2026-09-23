import { localhostAllowedHostnames } from '@modelcontextprotocol/server';

import { jsonRpcError } from './request.js';

/**
 * Checks that run before auth: which host the request names, whether it
 * arrived over HTTPS, and which page sent it. The request URL cannot answer
 * any of them alone, since its host comes from the client's `Host` header.
 * None of them proves where the connection came from: that is the listener's
 * binding, which this package cannot see.
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

/** A hostname or bracketed IPv6 address and an optional port: no userinfo, path, query or fragment. */
const AUTHORITY = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/;

/**
 * The `Host` header must be a bare authority, name the same authority as the
 * request URL (which the server built from it, or from a trusted proxy's
 * `X-Forwarded-Host`), and name an allowed host.
 */
function checkHost(
  request: Request,
  hosts: AllowedHosts,
): { ok: true; authority: string } | { ok: false; message: string } {
  const header = request.headers.get('host');

  if (header === null || header === '') {
    return { message: 'Missing Host header.', ok: false };
  }
  const url = new URL(request.url);
  let named: URL;

  try {
    if (!AUTHORITY.test(header)) {
      throw new Error('not an authority');
    }
    named = new URL(`${url.protocol}//${header}`);
  } catch {
    return { message: `Invalid Host header: ${header}`, ok: false };
  }
  if (named.host !== url.host) {
    return {
      message: `Host ${named.host} does not match the request authority.`,
      ok: false,
    };
  }
  if (hosts !== 'any' && !hosts.includes(named.hostname)) {
    return { message: `Invalid Host: ${named.hostname}`, ok: false };
  }

  return { authority: named.host, ok: true };
}

/** Hostnames as the Host check compares them: lower case, no port, IPv6 in brackets. */
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

/** The scheme the client used, as far as this deployment can know it. */
function clientScheme(request: Request, policy: HttpsPolicy): string {
  const forwarded = request.headers.get('x-forwarded-proto');

  // The last entry is the one the nearest proxy, the trusted one, wrote. When
  // present it is authoritative: TLS between proxy and server says nothing
  // about how the client connected.
  if (policy === 'trusted-proxy' && forwarded !== null) {
    return `${forwarded.split(',').at(-1)?.trim().toLowerCase() ?? ''}:`;
  }

  return new URL(request.url).protocol;
}

function isHttps(
  request: Request,
  policy: HttpsPolicy,
  where: Deployment,
): boolean {
  switch (policy) {
    case 'off':
      return true;
    case 'trusted-proxy':
      return clientScheme(request, policy) === 'https:';
    default:
      // Only Vercel's edge sets the scheme the function sees.
      return where === 'vercel' && clientScheme(request, policy) === 'https:';
  }
}

/** Exact origin equality: scheme, host and port, as a browser sends it. */
function originRefusal(
  request: Request,
  policy: HttpsPolicy,
  authority: string,
): string | null {
  const origin = request.headers.get('origin');

  if (origin === null || origin === '') {
    return null;
  }
  let claimed: string;
  let expected: string;

  try {
    claimed = new URL(origin).origin;
    expected = new URL(`${clientScheme(request, policy)}//${authority}`).origin;
  } catch {
    return `Invalid Origin header: ${origin}`;
  }

  return claimed === expected && claimed !== 'null'
    ? null
    : `Invalid Origin: ${origin}`;
}

export interface AdmissionPolicy {
  readonly allowedHosts?: AllowedHosts;
  readonly https: HttpsPolicy;
  readonly checkOrigin: boolean;
}

export const MISCONFIGURED_MESSAGE =
  "This MCP endpoint is not configured for this deployment: outside eve dev and Vercel, set allowedHosts, and https to 'trusted-proxy' or 'off'.";

/** A refusal, or null when the request may go on to auth. */
export function admissionRefusal(
  request: Request,
  policy: AdmissionPolicy,
  env: NodeJS.ProcessEnv = process.env,
): Response | null {
  const where = deployment(env);
  const hosts = hostList(policy.allowedHosts, where);

  // 'auto' can never admit a self-hosted request, so it is a setup error, not a 403.
  if (hosts === null || (where === 'other' && policy.https === 'auto')) {
    return jsonRpcError(MISCONFIGURED, SERVER_ERROR, MISCONFIGURED_MESSAGE);
  }
  const host = checkHost(request, hosts);

  if (!host.ok) {
    return refusal(host.message);
  }
  // Development servers take plain HTTP; `eve dev` listens on loopback.
  if (!(where === 'dev' || isHttps(request, policy.https, where))) {
    return refusal('HTTPS is required.');
  }
  const origin = policy.checkOrigin
    ? originRefusal(request, policy.https, host.authority)
    : null;

  return origin === null ? null : refusal(origin);
}
