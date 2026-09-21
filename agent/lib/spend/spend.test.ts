import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JUDGE_STATE, QUESTIONS, questionsOf } from '../judging/questions';
import { JEV_QUESTION_CHARS } from './spend';

const MAX_PATH_CHARS = 512;

/**
 * Where the fixed overhead would start to dominate a call: the smallest
 * judgeable files are a few thousand characters, so questions past this would
 * mean most of the bill is the asking, and the design needs revisiting rather
 * than the constant nudging.
 */
const OVERHEAD_CEILING_CHARS = 12_000;

/** What one call carries besides the code, from the one payload shape. */
function overheadChars(): number {
  return JSON.stringify({
    questions: questionsOf(QUESTIONS),
    state: { ...JUDGE_STATE.patch, path: 'a'.repeat(MAX_PATH_CHARS) },
  }).length;
}

test('the questions have not grown past what a per-call estimate can carry', () => {
  // The guard that can actually fail. `JEV_QUESTION_CHARS` is derived from
  // this same payload, so comparing the two would only ever restate the
  // margin; the number to watch is the absolute one, because up to eight calls
  // per file multiply it.
  assert.ok(
    overheadChars() <= OVERHEAD_CEILING_CHARS,
    `the questions now send ${overheadChars()} characters per call`,
  );
  assert.ok(overheadChars() <= JEV_QUESTION_CHARS);
});
