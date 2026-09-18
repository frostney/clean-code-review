/**
 * The model budgets, in a module that imports nothing: the eve adapter and the
 * MCP endpoint enforce them through `./spend.ts`, and the page, the FAQ,
 * /privacy, llms.txt and the Markdown twins quote them, so a cap cannot change
 * in one place and still be promised in another. It also holds the one reply
 * a refused page turn gives, because the agent writes it and the browser reads
 * it, and the browser must not import the cache.
 *
 * Two scopes, each counted on its own, per clock hour and per UTC day, across
 * every function instance. A per-address count cannot protect the project's
 * $15 weekly AI Gateway budget: one address looping at its full share, or many
 * addresses at once, would drain it in hours. Together the two days come to
 * $14 a week, under that budget. Once a scope's hour or day is spent, work
 * that needs a model is refused until the window turns; work answered entirely
 * from the cache is still served.
 */

/**
 * The page: every browser tab's judge and summarize turns together. A fresh
 * 24-file review measured about $0.02, so the hour holds about twenty of them.
 */
export const PAGE_HOURLY_BUDGET_USD = 0.4;
export const PAGE_DAILY_BUDGET_USD = 1;

/**
 * The MCP endpoint: every caller together. At the worst call measured, about
 * $0.06, the hour holds four such calls and the day about sixteen.
 */
export const MCP_HOURLY_BUDGET_USD = 0.25;
export const MCP_DAILY_BUDGET_USD = 1;

/** A budget as the docs and the refusals print it: `$0.25`. */
export const dollars = (usd: number) => `$${usd.toFixed(2)}`;

/** Which window of a budget ran out. */
export type BudgetWindow = 'hour' | 'day';

/** A page turn's whole reply when the page's budget is spent: no model ran. */
export interface PausedReply {
  kind: 'paused';
  window: BudgetWindow;
  /** ISO time the window turns, and reviews come back. */
  resetsAt: string;
}

/** Every paused reply starts with this, and no review or judgment does. */
const PAUSED_PREFIX = '{"kind":"paused"';

/** The reply the agent sends in place of a turn it refused. */
export function pausedReply(window: BudgetWindow, resetsAt: Date): string {
  const reply: PausedReply = {
    kind: 'paused',
    resetsAt: resetsAt.toISOString(),
    window,
  };
  // Written in key order `kind` first, so `PAUSED_PREFIX` recognises it.
  return JSON.stringify(reply);
}

/** A turn's reply read as a paused reply, or null when it is anything else. */
export function parsePaused(
  text: string | null | undefined,
): PausedReply | null {
  const trimmed = text?.trim() ?? '';
  if (!trimmed.startsWith(PAUSED_PREFIX)) {
    return null;
  }
  try {
    const reply = JSON.parse(trimmed) as Partial<PausedReply>;
    return (reply.window === 'hour' || reply.window === 'day') &&
      typeof reply.resetsAt === 'string' &&
      !Number.isNaN(Date.parse(reply.resetsAt))
      ? { kind: 'paused', resetsAt: reply.resetsAt, window: reply.window }
      : null;
  } catch {
    return null;
  }
}

/** True while a streamed reply so far could still be a paused one, so it is never painted as a review. */
export function mayBePaused(text: string): boolean {
  const head = text.trimStart();
  return head.length < PAUSED_PREFIX.length
    ? PAUSED_PREFIX.startsWith(head) && head.length > 0
    : head.startsWith(PAUSED_PREFIX);
}
