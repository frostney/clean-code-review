/**
 * The MCP endpoint's public facts, quoted by llms.txt, the Markdown twins and
 * /privacy. Kept apart from the server so `src/proxy.ts` does not pull in the review
 * pipeline; the model budget lives in `agent/lib/spend/budgets.ts`.
 */

export const MCP_PATH = '/api/mcp';

/** Where the server card proposal reserves it. */
export const MCP_SERVER_CARD_PATH = `${MCP_PATH}/server-card`;

/** Reverse-DNS because the server card format requires it; the runtime matches. */
export const MCP_SERVER_NAME = 'app.vercel.clean-code-review/review';
export const MCP_SERVER_VERSION = '1.0.0';

export const MCP_TOOLS = {
  paste: 'review_pasted_code',
  pullRequest: 'review_pull_request',
} as const;

/** Below the page's GitHub brake: one call here fetches, judges and writes a review. */
export const MCP_CALLS_PER_WINDOW = 10;

/** The review caps bound what reaches a model; this bounds what is parsed first. */
export const MAX_PASTE_CHARS = 1_000_000;

const MS_PER_MINUTE = 60_000;

/** The MCP's own window, the same length as the page's brake: retuning one must not move the other, since this one is published on /privacy and in llms.txt. */
export const MCP_WINDOW_MS = 600_000;

export const MCP_WINDOW_MINUTES = Math.round(MCP_WINDOW_MS / MS_PER_MINUTE);
