import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FileJudgment, ReviewFile } from '@/agent/lib/review/review';

import { gapsSentence, judgingGaps } from './judging-gaps';

const file = (path: string): ReviewFile => ({ content: 'const a = 1;', path });

const judged = (extra: Partial<FileJudgment> = {}): FileJudgment => ({
  answers: {},
  ms: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  windows: 1,
  windowsPlanned: 1,
  ...extra,
});

const none = { givenUp: {}, judgments: {}, pausedFiles: {}, pending: {} };

test('a file given up on with nothing held is named as unanswered', () => {
  // An edit whose new code failed twice: the page dropped the old code's answer.
  const gaps = judgingGaps([file('a.ts')], {
    ...none,
    givenUp: { 'a.ts': true },
  });

  assert.deepEqual(gaps.unjudged, ['a.ts']);
});

test('a file given up on while holding part of an answer is named by it', () => {
  // A Retry of unchanged code that failed twice keeps the parts it had.
  const gaps = judgingGaps([file('a.ts')], {
    ...none,
    givenUp: { 'a.ts': true },
    judgments: { 'a.ts': judged({ windows: 1, windowsPlanned: 2 }) },
  });

  assert.deepEqual(gaps, { oneReading: [], partial: ['a.ts'], unjudged: [] });
});

test('files being asked about again are not named', () => {
  const gaps = judgingGaps([file('a.ts')], {
    ...none,
    givenUp: { 'a.ts': true },
    pending: { 'a.ts': true },
  });

  assert.deepEqual(gaps.unjudged, []);
});

test('files are sorted by what is missing', () => {
  const gaps = judgingGaps([file('a.ts'), file('b.ts'), file('c.ts')], {
    ...none,
    judgments: {
      'a.ts': judged({ windows: 1, windowsPlanned: 2 }),
      'b.ts': judged({ strippedMissing: true }),
      'c.ts': judged(),
    },
  });

  assert.deepEqual(gaps.partial, ['a.ts']);
  assert.deepEqual(gaps.oneReading, ['b.ts']);
});

test('the sentence names what is missing, not more', () => {
  assert.equal(
    gapsSentence({ oneReading: [], partial: [], unjudged: ['a'] }),
    'Jev sent no answer for one file.',
  );
  assert.equal(
    gapsSentence({ oneReading: ['c'], partial: [], unjudged: [] }),
    'Jev read part of one file only with or only without its comments. Each card says what its verdict covers.',
  );
  assert.equal(
    gapsSentence({ oneReading: ['c'], partial: ['a', 'b'], unjudged: ['d'] }),
    'Jev sent no answer for one file, judged 2 only in part and read part of one only with or only without its comments. Each card says what its verdict covers.',
  );
});
