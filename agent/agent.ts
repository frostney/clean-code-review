import { defineAgent } from 'eve';

import { jev } from './lib/judging/jev-model';
import { SESSION_COST_CAP_USD } from './lib/review/review';

/** A tab that closes silently should not hold a session for long. */
const ONE_HOUR_MS = 3_600_000;

export default defineAgent({
  // Judging is a pure function of the snippet; untrusted code gets no shell, files or web.
  defaultTools: false,
  limits: {
    // The dollar cap in Jev tokens ($42 per billion), for calls that report
    // no cost. Luna's tokens count too, but her cost hits the dollar cap first.
    maxInputTokensPerSession: 12_000_000,
    // Each browser tab is one session, so this caps one tab's spend.
    maxTokenCostUsdPerSession: SESSION_COST_CAP_USD,
    sessionTimeoutMs: ONE_HOUR_MS,
  },
  model: jev(),
  // Jev is missing from the gateway's context-window catalog, and eve needs a
  // figure. Compaction never runs (the page clears history every turn), so
  // any sane number works.
  modelContextWindowTokens: 32_000,
});
