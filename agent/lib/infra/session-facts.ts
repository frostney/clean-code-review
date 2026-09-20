/**
 * The session brake's public figures, quoted by /privacy and its Markdown twin.
 * Kept out of `agent/channels/` because eve reads every file there as a channel,
 * and out of the channel itself so that importing a number does not construct
 * it; `channels/eve.ts` imports them back and is the only enforcer.
 */

export const SESSIONS_PER_WINDOW = 30;

export const SESSION_WINDOW_MS = 600_000;
