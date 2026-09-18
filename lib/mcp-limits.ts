/**
 * The MCP endpoint's public facts, in a module that imports nothing: the
 * server enforces them, and llms.txt, the Markdown twins and /privacy quote
 * them, so a limit cannot change in one place and still be promised in another.
 * The docs import this file rather than the server, because the server brings
 * the whole review pipeline with it and `proxy.ts` reads the docs. The
 * endpoint's model budget is in `agent/lib/budgets.ts`, beside the page's,
 * where the agent can reach both.
 */
import { WINDOW_MS } from './throttle';

/** Where the endpoint is mounted: `app/api/mcp/route.ts`. */
export const MCP_PATH = '/api/mcp';

/**
 * Where its server card is: the endpoint's own address plus `/server-card`,
 * the location the server card proposal reserves for it.
 */
export const MCP_SERVER_CARD_PATH = `${MCP_PATH}/server-card`;

/**
 * The server's name and version, as it reports them when a client connects
 * and as its server card declares them. The card format wants a reverse-DNS
 * name, so the runtime uses the same one rather than contradict it.
 */
export const MCP_SERVER_NAME = 'app.vercel.clean-code-review/review';
export const MCP_SERVER_VERSION = '1.0.0';

/** The two tools, by the names a client calls them. */
export const MCP_TOOLS = {
  paste: 'review_pasted_code',
  pullRequest: 'review_pull_request',
} as const;

/**
 * One address's share of review calls per window. Smaller than the page's
 * GitHub brake: a call here fetches, judges and writes a whole review, where a
 * fetch on the page is only the first of those.
 */
export const MCP_CALLS_PER_WINDOW = 10;

/**
 * The most text one paste may carry. The review caps cut what reaches a model
 * to 24 files of 16,000 characters; this bounds what is parsed before them.
 */
export const MAX_PASTE_CHARS = 1_000_000;

/** Minutes are how a reader counts the window; the brake counts milliseconds. */
const MS_PER_MINUTE = 60_000;

/** The window the MCP brake counts over, in minutes: the page's own ten. */
export const MCP_WINDOW_MINUTES = Math.round(WINDOW_MS / MS_PER_MINUTE);
