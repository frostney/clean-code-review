import { aiCatalog } from '@/src/mcp/mcp-card';

/**
 * The site's AI Catalog, at the one well-known location the server card
 * proposal uses: a list of what this domain offers an agent, which is one MCP
 * server, linked by the URL of its card. The document is in `src/mcp/mcp-card.ts`.
 */
export function GET(request: Request): Response {
  return aiCatalog.get(request);
}

export function OPTIONS(): Response {
  return aiCatalog.options();
}
