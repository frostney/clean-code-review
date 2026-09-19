import { serverCard } from '@/src/mcp/mcp-card';

export function GET(request: Request): Response {
  return serverCard.get(request);
}

export function OPTIONS(): Response {
  return serverCard.options();
}
