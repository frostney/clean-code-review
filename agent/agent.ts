import { defineAgent } from 'eve';

import { jev } from './lib/jev-model';

/** A tab that closes without saying so should not hold a session for long. */
const ONE_HOUR_MS = 3_600_000;

/**
 * The model is Jev (TypeSafe AI), reached through the Vercel AI Gateway: one
 * evaluation per turn, roughly half a second, priced at $42 per billion input
 * tokens. See lib/jev-model.ts for how an evaluation model sits in a language
 * model's slot.
 */
export default defineAgent({
  // Judging is a pure function of the snippet: no shell, files, or web needed.
  defaultTools: false,
  limits: {
    // The same ceiling in Jev tokens (at $42 per billion), in case a call ever
    // comes back without a reported cost. The reviewer's tokens count here
    // too, but its cost is what reaches the dollar cap first.
    maxInputTokensPerSession: 12_000_000,
    // Each browser tab is one durable session. The gateway reports every
    // call's cost — Jev's fractions of a cent and the reviewer subagent's
    // cents — so this caps what a single tab can spend.
    maxTokenCostUsdPerSession: 0.5,
    sessionTimeoutMs: ONE_HOUR_MS,
  },
  model: jev(),
  // Jev is not in the gateway's context-window catalog (it is an evaluation
  // model, not a chat model), and eve needs a figure to size compaction.
  // Compaction never runs here — the page clears history before every turn —
  // so this only has to be a sane number.
  modelContextWindowTokens: 32_000,
});
