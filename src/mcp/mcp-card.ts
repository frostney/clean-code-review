import { createHash } from 'node:crypto';

import { SITE } from '@/src/site/site';

import {
  MCP_PATH,
  MCP_SERVER_CARD_PATH,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
} from './mcp-limits';

/**
 * The MCP server described for a client that has not connected yet, in the
 * shape the server card proposal defines
 * (github.com/modelcontextprotocol/experimental-ext-server-card, SEP-2127).
 * The proposal is not yet part of the MCP specification, so this is advisory
 * metadata: the card itself says a client must prefer what it sees once
 * connected. Tools are deliberately not listed; a client asks the server.
 */

/** The server card's own media type, and the catalog's. */
const SERVER_CARD_TYPE = 'application/mcp-server-card+json';
const AI_CATALOG_TYPE = 'application/ai-catalog+json';

/** The card format's description allows 100 characters. */
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

/**
 * The domain's catalog, with the one server it offers. The identifier is the
 * format's domain-anchored URN: publisher, then `mcp`, then the server's name.
 */
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

/**
 * Headers the proposal asks of both documents: readable from a browser on any
 * origin, cached for an hour, and revalidated by entity tag after that.
 */
const CACHE_SECONDS = 3600;
const SHARED_HEADERS = {
  'access-control-allow-headers': 'Content-Type, If-None-Match',
  'access-control-allow-methods': 'GET',
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'ETag',
  'cache-control': `public, max-age=${CACHE_SECONDS}`,
};

const NO_CONTENT = 204;

/** Enough of a SHA-256 to tell two versions of one small document apart. */
const ETAG_CHARS = 22;
const NOT_MODIFIED = 304;

/** A fixed document, answered with its entity tag, or 304 when the client already has it. */
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
    /** The CORS preflight a browser sends before a request carrying `If-None-Match`. */
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
