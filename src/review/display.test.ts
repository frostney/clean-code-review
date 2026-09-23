import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FileJudgment } from '@/agent/lib/review/review';

import { coverageChip, partialCoverage, smellLabel } from './display';

const judged = (extra: Partial<FileJudgment>): FileJudgment => ({
  answers: {},
  ms: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  ...extra,
});

test('a file judged whole has no partial coverage', () => {
  assert.equal(
    partialCoverage(judged({ windows: 2, windowsPlanned: 2 })),
    null,
  );
  // A reply from before coverage was reported reads as whole.
  assert.equal(partialCoverage(judged({ windows: 1 })), null);
});

test('a lost window leaves the smell count a floor', () => {
  const coverage = partialCoverage(judged({ windows: 1, windowsPlanned: 2 }));

  assert.equal(coverage?.unread, true);
  assert.equal(coverageChip(coverage ?? assert.fail()), '1 of 2 parts judged');
  assert.equal(smellLabel(2, coverage?.unread), '2+ smells');
  assert.equal(smellLabel(0, coverage?.unread), 'no smells so far');
});

test('a missing comment-free reading is partial but reads every window', () => {
  const coverage = partialCoverage(
    judged({ strippedMissing: true, windows: 1, windowsPlanned: 1 }),
  );

  assert.equal(coverage?.unread, false);
  assert.equal(coverage?.strippedMissing, true);
  assert.equal(
    coverageChip(coverage ?? assert.fail()),
    'Judged as written only',
  );
});
