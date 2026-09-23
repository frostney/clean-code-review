import { defineAgent } from 'eve';

import { jev } from './lib/judging/jev-model';
import { TURN_CONTEXT_WINDOW_TOKENS } from './lib/review/prompt';
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
  // Not a real window. Before each model call eve estimates the instructions,
  // history and new message at JSON characters / 4, and past 90% of this
  // figure it compacts, sending its summary request to `jev()`, which judges
  // it as a code snippet. No model call receives a turn's message whole, and
  // the page clears history every turn, so the figure is sized for one
  // message: printable text at every page cap stays under the trigger
  // (`prompt.test.ts`). Control characters, very long paths or a direct
  // caller can still pass it. Each summary request then costs a Jev judgment,
  // clamped like any judge turn and charged to the page's spend brake, never a
  // Luna call; eve's per-session caps miss it, as eve drops compaction usage.
  modelContextWindowTokens: TURN_CONTEXT_WINDOW_TOKENS,
});
