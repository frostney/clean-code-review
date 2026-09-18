import { serverCard } from '@/lib/mcp-card';

/**
 * The MCP server's card, at the endpoint's own address plus `/server-card`,
 * which is the location the server card proposal reserves. The document is in
 * `lib/mcp-card.ts`; this route only serves it.
 */
export function GET(request: Request): Response {
  return serverCard.get(request);
}

export function OPTIONS(): Response {
  return serverCard.options();
}
