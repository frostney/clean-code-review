import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cappedAt, clampReview, MAX_JUDGED_CHARS } from './review';

function hasLoneSurrogate(text: string): boolean {
  return [...text].some((c) => {
    const code = c.codePointAt(0) ?? 0;

    return code >= 0xd800 && code <= 0xdfff;
  });
}

test('cappedAt leaves the text alone when it fits', () => {
  assert.equal(cappedAt('abc', 3), 'abc');
  assert.equal(cappedAt('a🙂', 3), 'a🙂');
});

test('cappedAt drops a character rather than halving it', () => {
  assert.equal(cappedAt('a🙂b', 2), 'a');
  assert.equal(cappedAt('ab🙂', 3), 'ab');
});

test('the clamp every judge message goes through cuts whole characters', () => {
  // `prompt.ts` routes each judge turn through this, so it, not the judging
  // itself, is the cut that fires in the product.
  const head = 'x'.repeat(MAX_JUDGED_CHARS - 1);
  const clamped = clampReview(
    { files: [{ content: `${head}🙂${'y'.repeat(5000)}`, path: 'a.ts' }] },
    MAX_JUDGED_CHARS,
  ).files[0].content;

  assert.equal(clamped.length, MAX_JUDGED_CHARS - 1);
  assert.ok(!hasLoneSurrogate(clamped));
});
