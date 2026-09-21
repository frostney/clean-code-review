/**
 * Imports nothing, so the browser can use it without pulling in the cache.
 * The page, FAQ, /privacy, llms.txt and Markdown twins quote these caps, so
 * change them only here.
 *
 * Caps are global rather than per address because per-address limits cannot
 * protect the $15 weekly AI Gateway budget; both daily caps total $14 a week.
 */

/** All browser tabs together. A fresh 24-file review measured about $0.02. */
export const PAGE_HOURLY_BUDGET_USD = 0.4;
export const PAGE_DAILY_BUDGET_USD = 1;

/** All MCP callers together. The worst call measured about $0.06. */
export const MCP_HOURLY_BUDGET_USD = 0.25;
export const MCP_DAILY_BUDGET_USD = 1;

export const dollars = (usd: number) => `$${usd.toFixed(2)}`;

/** `unavailable`: the counter could not be read, so uncached work is refused. */
export type BudgetWindow = 'hour' | 'day' | 'unavailable';

const WINDOWS: readonly BudgetWindow[] = ['hour', 'day', 'unavailable'];

export interface PausedReply {
  kind: 'paused';
  window: BudgetWindow;
  resetsAt: string;
  /** By the server's clock, so a browser with a fast clock does not retry at once. */
  waitMs: number;
}

/** Every paused reply starts with this, and no review or judgment does. */
const PAUSED_PREFIX = '{"kind":"paused"';

export function pausedReply(
  window: BudgetWindow,
  resetsAt: Date,
  now = new Date(),
): string {
  const reply: PausedReply = {
    kind: 'paused',
    resetsAt: resetsAt.toISOString(),
    waitMs: Math.max(0, resetsAt.getTime() - now.getTime()),
    window,
  };

  // `kind` must stay the first key for `PAUSED_PREFIX` to match.
  return JSON.stringify(reply);
}

export function parsePaused(
  text: string | null | undefined,
): PausedReply | null {
  const trimmed = text?.trim() ?? '';

  if (!trimmed.startsWith(PAUSED_PREFIX)) {
    return null;
  }
  try {
    const reply = JSON.parse(trimmed) as Partial<PausedReply>;

    if (
      !(reply.window && WINDOWS.includes(reply.window)) ||
      typeof reply.resetsAt !== 'string' ||
      Number.isNaN(Date.parse(reply.resetsAt))
    ) {
      return null;
    }
    const waitMs =
      typeof reply.waitMs === 'number' && Number.isFinite(reply.waitMs)
        ? Math.max(0, reply.waitMs)
        : Math.max(0, Date.parse(reply.resetsAt) - Date.now());

    return {
      kind: 'paused',
      resetsAt: reply.resetsAt,
      waitMs,
      window: reply.window,
    };
  } catch {
    return null;
  }
}

/** True while a partial stream could still become a paused reply, so it is not painted as a review. */
export function mayBePaused(text: string): boolean {
  const head = text.trimStart();

  return head.length < PAUSED_PREFIX.length
    ? PAUSED_PREFIX.startsWith(head) && head.length > 0
    : head.startsWith(PAUSED_PREFIX);
}
