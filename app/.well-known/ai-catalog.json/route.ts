import { aiCatalog } from '@/src/mcp/mcp-card';

// The well-known location the server card proposal uses.
export function GET(request: Request): Response {
  return aiCatalog.get(request);
}

export function OPTIONS(): Response {
  return aiCatalog.options();
}
