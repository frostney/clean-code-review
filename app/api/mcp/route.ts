import { createMcpHandler } from 'mcp-handler';

import { registerReviewTools } from '@/lib/mcp-server';
import { SITE } from '@/lib/site';

/**
 * The public MCP endpoint: stateless Streamable HTTP, for an agent with no
 * browser. Two tools, a pull request or pasted code, each returning the whole
 * review the page would show. `lib/mcp-server.ts` defines them and
 * `lib/mcp-review.ts` runs the review with the page's own functions.
 *
 * No session is kept between requests: every call carries its whole input, and
 * the only state is the caches the page already shares and a per-address
 * counter in this instance's memory. `proxy.ts` never sees this path; its
 * matcher leaves out everything under `/api/`.
 */
const handler = createMcpHandler(registerReviewTools, {
  instructions: `${SITE.name}: ${SITE.tagline} Jev answers the questions for every code file and Luna writes the review. Use review_pull_request for a public GitHub pull request, and review_pasted_code for a diff or files that are not on GitHub.`,
  serverInfo: { name: 'clean-code-review', version: '1.0.0' },
});

/** A pull request of 24 files is judged in seconds, but Luna can take most of a minute. */
export const maxDuration = 120;

export { handler as GET, handler as POST };
