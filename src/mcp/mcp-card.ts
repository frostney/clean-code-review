import { createHash } from 'node:crypto';

import { SITE } from '@/src/site/site';

import {
  MCP_PATH,
  MCP_SERVER_CARD_PATH,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
} from './mcp-limits';

/**
 * Server card proposal (SEP-2127, github.com/modelcontextprotocol/
 * experimental-ext-server-card): not yet in the MCP spec, so advisory only.
 * Tools are deliberately not listed; a client asks the server.
 */

const SERVER_CARD_TYPE = 'application/mcp-server-card+json';
const AI_CATALOG_TYPE = 'application/ai-catalog+json';

/** The card format allows 100 characters. */
const DESCRIPTION =
  'Judges code file by file against Clean Code and writes a review, from a pull request or pasted code.';

const SERVER_CARD = {
  // biome-ignore lint/style/useNamingConvention: the key is fixed by the server card format
  $schema:
    'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  description: DESCRIPTION,
  name: MCP_SERVER_NAME,
  remotes: [{ type: 'streamable-http', url: `${SITE.url}${MCP_PATH}` }],
  repository: { source: 'github', url: SITE.source },
  title: SITE.name,
  version: MCP_SERVER_VERSION,
  websiteUrl: SITE.url,
};

// Domain-anchored URN: publisher, then `mcp`, then the server's name.
const AI_CATALOG = {
  entries: [
    {
      identifier: `urn:air:${new URL(SITE.url).host}:mcp:review`,
      type: SERVER_CARD_TYPE,
      url: `${SITE.url}${MCP_SERVER_CARD_PATH}`,
    },
  ],
  specVersion: '1.0',
};

// Required by the proposal: any-origin CORS, an hour's cache, ETag revalidation.
const CACHE_SECONDS = 3600;
const SHARED_HEADERS = {
  'access-control-allow-headers': 'Content-Type, If-None-Match',
  'access-control-allow-methods': 'GET',
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'ETag',
  'cache-control': `public, max-age=${CACHE_SECONDS}`,
};

const NO_CONTENT = 204;

const ETAG_CHARS = 22;
const NOT_MODIFIED = 304;

function documentResponder(document: unknown, type: string) {
  const body = JSON.stringify(document, null, 2);
  const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, ETAG_CHARS)}"`;
  return {
    get(request: Request): Response {
      if (request.headers.get('if-none-match') === etag) {
        return new Response(null, {
          headers: { ...SHARED_HEADERS, etag },
          status: NOT_MODIFIED,
        });
      }
      return new Response(body, {
        headers: {
          ...SHARED_HEADERS,
          'content-type': `${type}; charset=utf-8`,
          etag,
        },
      });
    },
    /** Preflight: `If-None-Match` is not a CORS-safelisted header. */
    options(): Response {
      return new Response(null, {
        headers: SHARED_HEADERS,
        status: NO_CONTENT,
      });
    },
  };
}

export const serverCard = documentResponder(SERVER_CARD, SERVER_CARD_TYPE);
export const aiCatalog = documentResponder(AI_CATALOG, AI_CATALOG_TYPE);
