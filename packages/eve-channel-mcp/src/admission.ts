import { BlockList, isIPv4, isIPv6 } from 'node:net';

import { localhostAllowedHostnames } from '@modelcontextprotocol/server';

import { jsonRpcError } from './request.js';

/**
 * Checks that run before auth: which host the request names, whether it
 * arrived over HTTPS, and which page sent it. The request URL cannot answer
 * any of them alone, since its host comes from the client's `Host` header.
 * Only the development HTTPS waiver looks at where the connection came from,
 * through the address eve reports.
 */

export type AllowedHosts = readonly string[] | 'any';

/** How to tell that a request arrived over HTTPS. */
export type HttpsPolicy = 'auto' | 'trusted-proxy' | 'off';

type Deployment = 'dev' | 'vercel' | 'other';

const SERVER_ERROR = -32_000;
const FORBIDDEN = 403;
const MISCONFIGURED = 500;

const LOOPBACK = localhostAllowedHostnames();

/**
 * Read per request: a build can evaluate the channel without the runtime's
 * environment. Only `EVE_DEV`, which `eve dev` sets for itself, means
 * development. `vercel env pull` can write `VERCEL=1` and
 * `VERCEL_ENV=development` into the `.env.local` that `eve start` also
 * loads, and no deployed function runs with `VERCEL_ENV=development`.
 */
export function deployment(env: NodeJS.ProcessEnv = process.env): Deployment {
  if (env.EVE_DEV === '1') {
    return 'dev';
  }

  return env.VERCEL === '1' && env.VERCEL_ENV !== 'development'
    ? 'vercel'
    : 'other';
}

/**
 * Loopback under `eve dev`; any host on Vercel, whose edge routes by `Host`
 * to this deployment's own domains only; elsewhere, the app's list, which is
 * required.
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
const AUTHORITY = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::\d{1,5})?$/;

/** The part of srvx's request, eve's server, that exposes the Node request it adapted. */
interface NodeAdapted {
  readonly runtime?: {
    readonly node?: {
      readonly req?: {
        readonly httpVersion?: unknown;
        readonly headers?: Readonly<Record<string, unknown>>;
      };
    };
  };
}

/**
 * The authority the client named. HTTP/2 sends it as `:authority`, which
 * srvx builds the request URL from but leaves out of `headers`. HTTP/1.1
 * has no such field, so there a missing `Host` stays missing.
 */
function namedAuthority(request: Request): string | null {
  const host = request.headers.get('host');

  if (host !== null && host !== '') {
    return host;
  }
  const node = (request as Request & NodeAdapted).runtime?.node?.req;
  const authority =
    node?.httpVersion === '2.0' ? node.headers?.[':authority'] : undefined;

  return typeof authority === 'string' && authority !== '' ? authority : null;
}

/**
 * How this endpoint names itself, decided here only: the authority the
 * `Host` header must match is the one the server built the request URL
 * from, and a browser request's own origin is the client's scheme with the
 * authority `Host` names. `X-Forwarded-Host` never counts: anyone can point
 * a rewrite at a deployment, so another domain gets in only through
 * `allowedOrigins`.
 */
const endpoint = {
  authority: (request: Request): string => new URL(request.url).host,
  origin: (request: Request, https: HttpsPolicy, host: string): string =>
    new URL(`${clientScheme(request, https)}//${host}`).origin,
};

/**
 * The `Host` header must be a bare authority, name the endpoint's own
 * authority, and name an allowed host.
 */
function checkHost(
  request: Request,
  hosts: AllowedHosts,
): { ok: true; authority: string } | { ok: false; message: string } {
  const header = namedAuthority(request);

  if (header === null) {
    return { message: 'Missing Host header.', ok: false };
  }
  let named: URL;

  try {
    if (!AUTHORITY.test(header)) {
      throw new Error('not an authority');
    }
    named = new URL(`${new URL(request.url).protocol}//${header}`);
  } catch {
    return { message: `Invalid Host header: ${header}`, ok: false };
  }
  if (named.host !== endpoint.authority(request)) {
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

/** Exactly what a browser sends as `Origin`, so the check can compare strings. */
export function checkedOrigin(entry: string): string {
  let parsed: URL | null = null;

  try {
    parsed = typeof entry === 'string' ? new URL(entry) : null;
  } catch {
    // Reported below.
  }
  if (
    !(
      (parsed?.protocol === 'https:' || parsed?.protocol === 'http:') &&
      parsed.origin === entry
    )
  ) {
    throw new Error(
      `allowedOrigins: "${String(entry)}" must be an HTTP(S) origin as a browser sends it: scheme://host[:port] in lower case, without a default port, path, query or fragment.`,
    );
  }

  return entry;
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

const LOOPBACK_ADDRESSES = new BlockList();

LOOPBACK_ADDRESSES.addRange('127.0.0.0', '127.255.255.255', 'ipv4');
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6');

/** `BlockList` counts an IPv4-mapped IPv6 address as the IPv4 address it carries. */
function isLoopbackAddress(address: string | null): boolean {
  if (address === null) {
    return false;
  }
  if (isIPv4(address)) {
    return LOOPBACK_ADDRESSES.check(address, 'ipv4');
  }

  return isIPv6(address) && LOOPBACK_ADDRESSES.check(address, 'ipv6');
}

/** Exact origin equality with this endpoint, or an origin the app listed. */
function originRefusal(
  request: Request,
  own: () => string,
  allowed: readonly string[],
): string | null {
  const origin = request.headers.get('origin');

  if (origin === null || origin === '') {
    return null;
  }
  let claimed: string;
  let expected: string;

  try {
    claimed = new URL(origin).origin;
    expected = own();
  } catch {
    return `Invalid Origin header: ${origin}`;
  }

  return claimed !== 'null' &&
    (claimed === expected || allowed.includes(claimed))
    ? null
    : `Invalid Origin: ${origin}`;
}

export interface AdmissionPolicy {
  readonly allowedHosts?: AllowedHosts;
  /** Browser origins accepted besides the endpoint's own, each as `checkedOrigin` returns it. */
  readonly allowedOrigins?: readonly string[];
  readonly https: HttpsPolicy;
  readonly checkOrigin: boolean;
}

export const MISCONFIGURED_MESSAGE =
  "This MCP endpoint is not configured for this deployment: outside eve dev and Vercel, set allowedHosts, and https to 'trusted-proxy' or 'off'.";

/**
 * A refusal, or null when the request may go on to auth. `requestIp` is the
 * address eve reports for the client; under `eve dev` its dev server signs
 * the peer it saw.
 */
export function admissionRefusal(
  request: Request,
  policy: AdmissionPolicy,
  env: NodeJS.ProcessEnv,
  requestIp: string | null,
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
  // `eve dev --host 0.0.0.0` accepts other machines, and a loopback `Host`
  // is any client's to send; only a loopback peer gets plain HTTP.
  const localDevelopment = where === 'dev' && isLoopbackAddress(requestIp);

  if (!(localDevelopment || isHttps(request, policy.https, where))) {
    return refusal('HTTPS is required.');
  }
  const origin = policy.checkOrigin
    ? originRefusal(
        request,
        () => endpoint.origin(request, policy.https, host.authority),
        policy.allowedOrigins ?? [],
      )
    : null;

  return origin === null ? null : refusal(origin);
}
