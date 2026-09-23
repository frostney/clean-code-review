/**
 * RFC 9728 protected-resource metadata, and the `resource_metadata`
 * parameter that points an MCP client's 401 at it, from explicit settings.
 * eve's `oauthResource()` carries the same settings, but only through an
 * internal reader, so they are passed to the channel instead.
 */

export interface McpOAuthOptions {
  /** The public URL of this MCP endpoint, as clients reach it. */
  readonly resource: string;
  /** Exactly one of `issuer` and `authorizationServers`. */
  readonly issuer?: string;
  readonly authorizationServers?: readonly string[];
  /** Advertised to clients; the auth strategy still enforces them. */
  readonly scopes?: readonly string[];
  /** Defaults to RFC 9728's path for `resource`; behind `withEve` it must be under `/eve/v1/`. */
  readonly metadataPath?: string;
}

export interface OAuthConfig {
  readonly document: Readonly<Record<string, unknown>>;
  readonly metadataPath: string;
  readonly metadataUrl: string;
  readonly scopes: readonly string[];
}

const WELL_KNOWN = '/.well-known/oauth-protected-resource';

/** `localhost`, `*.localhost`, 127.0.0.0/8 and `::1`, as eve's `oauthResource()` counts them. */
function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');

  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name) ||
    name === '[::1]'
  );
}

/**
 * The rules eve's `oauthResource()` applies: HTTPS, or HTTP on loopback
 * only, and no credentials, query or fragment, since these URLs are
 * published to anyone who asks.
 */
function identifierUrl(label: string, value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`oauth.${label} must be an absolute URL.`);
  }
  const secure =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && isLoopbackHostname(url.hostname));

  if (
    !(
      secure &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    )
  ) {
    throw new Error(
      `oauth.${label} must be an HTTPS URL without credentials, query or fragment (HTTP only on loopback).`,
    );
  }

  return url;
}

/** An absolute path on the resource's own origin, with no query or fragment. */
function checkedMetadataPath(path: string): string {
  const probe = 'https://resource.invalid';
  let resolved: URL | null = null;

  try {
    resolved = new URL(path, probe);
  } catch {
    // Reported below.
  }
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    resolved?.origin !== probe ||
    resolved.search !== '' ||
    resolved.hash !== ''
  ) {
    throw new Error(
      'oauth.metadataPath must be an absolute path without a host, query or fragment.',
    );
  }

  return path;
}

export function resolveOAuth(options: McpOAuthOptions): OAuthConfig {
  const resource = identifierUrl('resource', options.resource);
  const servers =
    options.issuer === undefined
      ? (options.authorizationServers ?? [])
      : [options.issuer];

  if (
    (options.issuer === undefined) ===
      (options.authorizationServers === undefined) ||
    servers.length === 0
  ) {
    throw new Error(
      'oauth needs exactly one of issuer and authorizationServers.',
    );
  }
  for (const server of servers) {
    identifierUrl('issuer', server);
  }
  const resourcePath = resource.pathname.replace(/(.)\/$/, '$1');
  const metadataPath = checkedMetadataPath(
    options.metadataPath ??
      (resourcePath === '/' ? WELL_KNOWN : `${WELL_KNOWN}${resourcePath}`),
  );

  return {
    document: {
      // biome-ignore-start lint/style/useNamingConvention: RFC 9728 field names
      authorization_servers: [...servers],
      resource: resource.href,
      ...(options.scopes === undefined
        ? {}
        : { scopes_supported: [...options.scopes] }),
      // biome-ignore-end lint/style/useNamingConvention: RFC 9728 field names
    },
    metadataPath,
    metadataUrl: new URL(metadataPath, resource).href,
    scopes: options.scopes ?? [],
  };
}

/** RFC 9110 quoted-string: escape the two characters it reserves; line breaks cannot appear in a header. */
export function quoteParameter(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
  const printable = value.replace(/[\u0000-\u001f\u007f]/g, '');

  return `"${printable.replace(/[\\"]/g, '\\$&')}"`;
}

/** Splits on commas that are not inside a quoted string. */
function splitOutsideQuotes(text: string): string[] {
  const pieces: string[] = [];
  let quoted = false;
  let escaped = false;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      pieces.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  pieces.push(text.slice(start).trim());

  return pieces.filter(Boolean);
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+/;

export interface Challenge {
  readonly scheme: string;
  /** Parameter names in lower case, values unquoted. */
  readonly params: ReadonlyMap<string, string>;
  readonly raw: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();

  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1
    ? trimmed.slice(1, -1).replace(/\\(.)/g, '$1')
    : trimmed;
}

/** `name=value` into the map; anything else (a token68) is kept only in `raw`. */
function addParameter(params: Map<string, string>, piece: string): void {
  const name = TOKEN.exec(piece)?.[0];
  const rest = name === undefined ? '' : piece.slice(name.length).trimStart();

  if (name !== undefined && rest.startsWith('=')) {
    params.set(name.toLowerCase(), unquote(rest.slice(1)));
  }
}

/** One entry per challenge, with parameters parsed so quoted text is never mistaken for one. */
export function parseChallenges(header: string): Challenge[] {
  const challenges: {
    scheme: string;
    params: Map<string, string>;
    raw: string;
  }[] = [];

  for (const piece of splitOutsideQuotes(header)) {
    const token = TOKEN.exec(piece)?.[0];
    const opensChallenge =
      token !== undefined &&
      !piece.slice(token.length).trimStart().startsWith('=');
    const current = challenges.at(-1);

    if (opensChallenge || current === undefined) {
      const params = new Map<string, string>();
      const first = piece.slice(token?.length ?? 0).trim();

      if (first) {
        addParameter(params, first);
      }
      challenges.push({ params, raw: piece, scheme: token ?? piece });
    } else {
      addParameter(current.params, piece);
      current.raw += `, ${piece}`;
    }
  }

  return challenges;
}

function withParameters(
  challenge: Challenge,
  added: readonly (readonly [string, string])[],
): string {
  const missing = added.filter(([name]) => !challenge.params.has(name));
  const text = missing.map(
    ([name, value]) => `${name}=${quoteParameter(value)}`,
  );

  if (text.length === 0) {
    return challenge.raw;
  }

  return challenge.raw.trim() === challenge.scheme
    ? `${challenge.raw} ${text.join(', ')}`
    : `${challenge.raw}, ${text.join(', ')}`;
}

const UNAUTHORIZED = 401;
const FORBIDDEN = 403;

function isBearer(challenge: Challenge): boolean {
  return challenge.scheme.toLowerCase() === 'bearer';
}

/**
 * Points a refusal at the metadata, so an MCP client can start sign-in: a
 * 401's Bearer challenge (one naming an `error` first), or on a 403 the
 * Bearer challenge whose `error` is `insufficient_scope`.
 */
export function withResourceChallenge(
  response: Response,
  oauth: OAuthConfig,
): Response {
  const challenges = parseChallenges(
    response.headers.get('www-authenticate') ?? '',
  );
  let target: number;

  if (response.status === UNAUTHORIZED) {
    const withError = challenges.findIndex(
      (c) => isBearer(c) && c.params.has('error'),
    );

    target = withError === -1 ? challenges.findIndex(isBearer) : withError;
  } else if (response.status === FORBIDDEN) {
    target = challenges.findIndex(
      (c) => isBearer(c) && c.params.get('error') === 'insufficient_scope',
    );
    if (target === -1) {
      return response;
    }
  } else {
    return response;
  }
  const added: [string, string][] = [['resource_metadata', oauth.metadataUrl]];

  if (response.status === UNAUTHORIZED && oauth.scopes.length > 0) {
    added.push(['scope', oauth.scopes.join(' ')]);
  }
  const bearer = challenges[target] ?? {
    params: new Map<string, string>(),
    raw: 'Bearer',
    scheme: 'Bearer',
  };
  const values = challenges.map((c) => c.raw);

  if (target === -1) {
    values.push(withParameters(bearer, added));
  } else {
    values[target] = withParameters(bearer, added);
  }
  const headers = new Headers(response.headers);

  headers.set('www-authenticate', values.join(', '));

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};
const NO_CONTENT = 204;

/** Browser-hosted clients discover the authorization server cross-origin. */
export function metadataResponse(
  request: Request,
  oauth: OAuthConfig,
): Response {
  if (request.method === 'OPTIONS') {
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
  }
  const full = Response.json(oauth.document, { headers: CORS_HEADERS });

  return request.method === 'HEAD'
    ? new Response(null, { headers: full.headers })
    : full;
}
