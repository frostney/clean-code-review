/**
 * What one browser tab may spend before the agent stops answering.
 *
 * Mirrors `limits.maxTokenCostUsdPerSession` in `agent/agent.ts` — each tab is
 * one durable eve session, so that cap and this number describe the same
 * ceiling. It is duplicated rather than imported because `agent/agent.ts`
 * pulls in the eve server runtime, which has no business in a browser bundle.
 * If you change it there, change it here. At Jev's prices a turn costs a
 * fraction of a cent, so this is thousands of judgments per tab.
 */
export const SESSION_BUDGET_USD = 0.5;
