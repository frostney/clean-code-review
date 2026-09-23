import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FileJudgment } from '@/agent/lib/review/review';

import {
  coverageChip,
  coverageSentence,
  partialCoverage,
  smellLabel,
} from './display';

const judged = (extra: Partial<FileJudgment>): FileJudgment => ({
  answers: {},
  ms: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  ...extra,
});

function partial(extra: Partial<FileJudgment>) {
  return partialCoverage(judged(extra)) ?? assert.fail('not partial');
}

test('a file judged whole has no partial coverage', () => {
  assert.equal(
    partialCoverage(judged({ windows: 2, windowsPlanned: 2 })),
    null,
  );
  // A reply from before coverage was reported reads as whole.
  assert.equal(partialCoverage(judged({ windows: 1 })), null);
});

test('a window unread in both readings leaves the smell count a floor', () => {
  const coverage = partial({ windows: 1, windowsPlanned: 2 });

  assert.equal(coverage.floor, true);
  assert.equal(coverageChip(coverage), '1 of 2 parts judged');
  assert.match(coverageSentence(coverage), /can only lower the verdict/);
  assert.equal(smellLabel(2, coverage.floor), '2+ smells');
  assert.equal(smellLabel(0, coverage.floor), 'no smells so far');
});

test('a window read only without its comments counts as read', () => {
  const coverage = partial({ strippedOnly: 1, windows: 1, windowsPlanned: 2 });

  assert.equal(coverage.read, 2);
  assert.equal(coverage.floor, true);
  assert.equal(coverageChip(coverage), 'Partly judged without comments');
  assert.doesNotMatch(coverageSentence(coverage), /went unjudged/);
  assert.match(coverageSentence(coverage), /no question about comments/);
  assert.match(coverageSentence(coverage), /asking again can only lower/);
  assert.doesNotMatch(coverageSentence(coverage), /the rest/);
});

test('a missing comment-free reading is no floor and says so', () => {
  const coverage = partial({
    strippedMissing: true,
    windows: 2,
    windowsPlanned: 2,
  });

  assert.equal(coverage.floor, false);
  assert.equal(coverageChip(coverage), 'Partly judged as written');
  assert.match(coverageSentence(coverage), /either way/);
  assert.doesNotMatch(coverageSentence(coverage), /can only lower/);
});

test('an unread window beside a missing comment-free reading is no floor', () => {
  // Asking again replaces the code answers read with comments in view, which
  // can raise the verdict or clear a smell.
  const coverage = partial({
    strippedMissing: true,
    windows: 1,
    windowsPlanned: 2,
  });

  assert.equal(coverage.floor, false);
  assert.equal(coverageChip(coverage), '1 of 2 parts judged');
  assert.equal(smellLabel(2, coverage.floor), '2 smells');
  assert.doesNotMatch(coverageSentence(coverage), /can only lower/);
});
