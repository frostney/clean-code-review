import assert from 'node:assert/strict';
import { test } from 'node:test';

import { QUESTIONS } from '../judging/questions';
import type { Answers } from '../judging/schema';
import {
  buildInstructions,
  judgeMessage,
  summarizeMessage,
  TURN_CONTEXT_WINDOW_TOKENS,
} from './prompt';
import { MAX_JUDGED_CHARS, REVIEW_LIMITS } from './review';

// eve 0.64 compacts before a model call once its estimate of the call (JSON
// characters / 4 of instructions, tools and messages) plus its ~400-token
// checkpoint prompt passes 90% of the window. This agent has no tools.
const COMPACTION_TRIGGER = 0.9;
const CHECKPOINT_PROMPT_TOKENS = 1000;
const CHARS_PER_TOKEN = 4;

/** GitHub's caps on a pull request's title and description. */
const PR_TITLE_CHARS = 256;
const PR_BODY_CHARS = 65_536;
const PATH_CHARS = 200;

function eveEstimate(message: string): number {
  const request = JSON.stringify({
    instructions: buildInstructions(),
    messages: [{ content: message, role: 'user' }],
    tools: [],
  });

  return request.length / CHARS_PER_TOKEN + CHECKPOINT_PROMPT_TOKENS;
}

// Every file at the judged-character cap, in quotes: escaped twice on the way
// into eve's estimate, a quote costs four characters, the most of any printable
// character. Not the largest possible message: control characters cost seven
// and paths have no cap, so either can pass the trigger (see `agent.ts`).
const filesAtCaps = Array.from({ length: REVIEW_LIMITS.maxFiles }, (_, i) => ({
  content: '"'.repeat(MAX_JUDGED_CHARS),
  patch: true,
  path: `${String(i).padStart(2, '0')}/${'"'.repeat(PATH_CHARS)}`,
}));

/** A probability printed at full precision. */
const LONG_FLOAT = 1 / 3;
const noisyProbabilities = Object.fromEntries(
  ['a', 'b', 'c', 'd', 'e'].map((k) => [k, LONG_FLOAT]),
);
const fullAnswers: Answers = Object.fromEntries(
  QUESTIONS.map((q) => [
    q.id,
    {
      choice: 'request_changes',
      confidence: LONG_FLOAT,
      probabilities: noisyProbabilities,
      type: 'choice',
    },
  ]),
);

const trigger = TURN_CONTEXT_WINDOW_TOKENS * COMPACTION_TRIGGER;

test('a judge message of printable text at every page cap stays under eve’s compaction trigger', () => {
  assert.ok(eveEstimate(judgeMessage({ files: filesAtCaps })) < trigger);
});

test('a summarize message of printable text at every page cap stays under eve’s compaction trigger', () => {
  const message = summarizeMessage({
    files: filesAtCaps,
    judgments: Object.fromEntries(
      filesAtCaps.map((f) => [f.path, fullAnswers]),
    ),
    pr: {
      body: '"'.repeat(PR_BODY_CHARS),
      title: '"'.repeat(PR_TITLE_CHARS),
      url: 'https://github.com/o/r/pull/1',
    },
  });

  assert.ok(eveEstimate(message) < trigger);
});
