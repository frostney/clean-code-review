import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '@/src/mcp/mcp-facts';
import { registerReviewTools } from '@/src/mcp/mcp-server';
import { SITE } from '@/src/site/site';

const INSTRUCTIONS = `${SITE.name}: ${SITE.tagline} Jev judges the code file by file and Luna writes the review. Use review_pull_request for a public GitHub pull request, and review_pasted_code for a diff or files that are not on GitHub.`;

// A server per request, for 2026-07-28 and, by the default `legacy:
// 'stateless'`, for 2025-era clients. `proxy.ts`'s matcher excludes `/api/`.
const handler = createMcpHandler(() => {
  // Must match the server card.
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerReviewTools(server);

  return server;
});

/** JSON-RPC "Invalid Request". */
const INVALID_REQUEST = -32_600;
const BAD_REQUEST = 400;

/**
 * Batches are refused before the handler: each `tools/call` in one would start
 * a review behind a single Firewall-counted request. MCP dropped batches in
 * 2025-06-18, but the SDK's stateless path still accepts them.
 */
async function post(request: Request): Promise<Response> {
  const body = await request.clone().text();

  if (body.trimStart().startsWith('[')) {
    return Response.json(
      {
        error: {
          code: INVALID_REQUEST,
          message:
            'Batches are not accepted: send one JSON-RPC message per request.',
        },
        id: null,
        jsonrpc: '2.0',
      },
      { status: BAD_REQUEST },
    );
  }

  return handler.fetch(request);
}

/** Nothing is held open, so the SDK answers 405 with a JSON-RPC body a 2025 client reads; Next's own 405 has none. */
function get(request: Request): Promise<Response> {
  return handler.fetch(request);
}

/**
 * Judging is seconds; Luna's written review can take most of a minute. Equal
 * to `MCP_MAX_DURATION_SECONDS`, which the review's deadlines are cut from.
 */
export const maxDuration = 120;

export { get as GET, post as POST };
