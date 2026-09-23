import { GET, HEAD, type HttpRouteDefinition, OPTIONS } from 'eve/channels';
import {
  type AuthFn,
  escapeAuthChallengeParameter,
  type OAuthResourceOptions,
  readOAuthResourceOptions,
} from 'eve/channels/auth';

/**
 * RFC 9728 protected-resource metadata for an `auth` wrapped in eve's
 * `oauthResource()`, published the way eve's own `mcpChannel` does.
 *
 * `readOAuthResourceOptions` is exported from `eve/channels/auth` but tagged
 * internal in its declaration; this module is the only reader, so a rename
 * there is a one-line change here.
 */

const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const NO_CONTENT = 204;

const METADATA_ROOT = '/.well-known/oauth-protected-resource';

export function oauthOptions(
  auth: AuthFn<Request> | readonly AuthFn<Request>[],
): OAuthResourceOptions | undefined {
  return readOAuthResourceOptions(auth);
}

export function metadataPath(
  options: OAuthResourceOptions,
  route: string,
): string {
  if (options.metadataPath !== undefined) {
    return options.metadataPath;
  }
  const resourcePath =
    options.resource === undefined ? route : new URL(options.resource).pathname;

  return resourcePath === '/'
    ? METADATA_ROOT
    : `${METADATA_ROOT}${resourcePath}`;
}

function resourceUrl(
  options: OAuthResourceOptions,
  route: string,
  request: Request,
): string {
  return options.resource ?? new URL(route, request.url).toString();
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};

function metadataResponse(
  options: OAuthResourceOptions,
  route: string,
  request: Request,
): Response {
  const servers =
    options.issuer === undefined
      ? options.authorizationServers
      : [options.issuer];

  return Response.json(
    {
      // biome-ignore-start lint/style/useNamingConvention: RFC 9728 field names
      authorization_servers: servers,
      resource: resourceUrl(options, route, request),
      ...(options.scopes === undefined
        ? {}
        : { scopes_supported: options.scopes }),
      // biome-ignore-end lint/style/useNamingConvention: RFC 9728 field names
    },
    { headers: CORS_HEADERS },
  );
}

/** Browser-hosted clients discover the authorization server cross-origin. */
export function metadataRoutes(
  options: OAuthResourceOptions,
  route: string,
): HttpRouteDefinition[] {
  const path = metadataPath(options, route);

  return [
    GET(path, async (request) => metadataResponse(options, route, request)),
    HEAD(path, async (request) => {
      const full = metadataResponse(options, route, request);

      return new Response(null, { headers: full.headers });
    }),
    OPTIONS(path, async (request) => {
      const headers = new Headers({
        ...CORS_HEADERS,
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      });
      const asked = request.headers.get('access-control-request-headers');

      if (asked) {
        headers.set('access-control-allow-headers', asked);
        headers.set('vary', 'Access-Control-Request-Headers');
      }

      return new Response(null, { headers, status: NO_CONTENT });
    }),
  ];
}

function withParameter(challenge: string, name: string, value: string): string {
  if (new RegExp(`(?:^|[\\s,])${name}\\s*=`, 'i').test(challenge)) {
    return challenge;
  }
  const separator = /^\S+$/.test(challenge.trim()) ? ' ' : ', ';

  return `${challenge}${separator}${name}="${escapeAuthChallengeParameter(value)}"`;
}

/** Splits on commas that are not inside a quoted string. */
function splitOutsideQuotes(header: string): string[] {
  const pieces: string[] = [];
  let quoted = false;
  let escaped = false;
  let start = 0;

  for (let i = 0; i < header.length; i++) {
    const char = header[i];

    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      pieces.push(header.slice(start, i).trim());
      start = i + 1;
    }
  }
  pieces.push(header.slice(start).trim());

  return pieces.filter(Boolean);
}

/** One entry per challenge, with each parameter re-joined to its scheme. */
export function splitChallenges(header: string): string[] {
  const challenges: string[] = [];

  for (const piece of splitOutsideQuotes(header)) {
    // `Bearer error="…"` opens a challenge; `scope="…"` continues one.
    const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+/.exec(piece)?.[0];
    const startsScheme =
      token !== undefined &&
      !piece.slice(token.length).trimStart().startsWith('=');

    if (startsScheme || challenges.length === 0) {
      challenges.push(piece);
    } else {
      challenges[challenges.length - 1] += `, ${piece}`;
    }
  }

  return challenges;
}

/**
 * Points a refusal at the metadata, so an MCP client can start sign-in: every
 * 401, and a 403 that already says `insufficient_scope`.
 */
export function withResourceChallenge(
  response: Response,
  options: OAuthResourceOptions,
  route: string,
  request: Request,
): Response {
  const existing = response.headers.get('www-authenticate') ?? '';
  const scopeRefusal =
    response.status === FORBIDDEN && /insufficient_scope/i.test(existing);

  if (response.status !== UNAUTHORIZED && !scopeRefusal) {
    return response;
  }
  const metadata = new URL(
    metadataPath(options, route),
    options.resource ?? request.url,
  ).toString();
  const challenges = splitChallenges(existing);
  const bearerAt = challenges.findIndex((c) => /^bearer\b/i.test(c));
  let bearer = withParameter(
    bearerAt === -1 ? 'Bearer' : (challenges[bearerAt] ?? 'Bearer'),
    'resource_metadata',
    metadata,
  );

  if (options.scopes?.length && response.status === UNAUTHORIZED) {
    bearer = withParameter(bearer, 'scope', options.scopes.join(' '));
  }
  if (bearerAt === -1) {
    challenges.push(bearer);
  } else {
    challenges[bearerAt] = bearer;
  }
  const headers = new Headers(response.headers);

  headers.set('www-authenticate', challenges.join(', '));

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
