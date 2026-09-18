import { createMcpHandler } from 'mcp-handler';

import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '@/src/mcp/mcp-limits';
import { registerReviewTools } from '@/src/mcp/mcp-server';
import { SITE } from '@/src/site/site';

/**
 * The public MCP endpoint: stateless Streamable HTTP, for an agent with no
 * browser. Two tools, a pull request or pasted code, each returning the whole
 * review the page would show. `src/mcp/mcp-server.ts` defines them and
 * `src/mcp/mcp-review.ts` runs the review with the page's own functions.
 *
 * No session is kept between requests: every call carries its whole input, and
 * the only state is the caches the page already shares, a per-address counter
 * in this instance's memory, and the model budget every caller shares, kept in
 * the Runtime Cache. `proxy.ts` never sees this path; its matcher leaves out
 * everything under `/api/`.
 */
const handler = createMcpHandler(registerReviewTools, {
  instructions: `${SITE.name}: ${SITE.tagline} Jev judges the code file by file and Luna writes the review. Use review_pull_request for a public GitHub pull request, and review_pasted_code for a diff or files that are not on GitHub.`,
  // The same name and version the server card declares, so a client that read
  // the card first finds what it expected when it connects.
  serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
});

/** JSON-RPC's "Invalid Request": the body is JSON, but not one request. */
const INVALID_REQUEST = -32_600;
const BAD_REQUEST = 400;

/**
 * One JSON-RPC message per POST. A batch would run every `tools/call` in it at
 * once, so one request counted once by the Firewall could start many reviews.
 * The protocol dropped batches in 2025-06-18 and no client of a later version
 * sends one, but the SDK's stateless path still accepts them, so any body
 * that is a JSON array is answered here, before the handler parses it and
 * before any tool runs.
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
  return handler(request);
}

/** A pull request of 24 files is judged in seconds, but Luna can take most of a minute. */
export const maxDuration = 120;

export { handler as GET, post as POST };
