import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isFinding, QUESTIONS, questionById, questionsOf } from './questions';

test('every yes/no question carries a cutoff strictly between 0 and 1', () => {
  for (const q of QUESTIONS) {
    if (q.type === 'noul') {
      assert.ok(q.cutoff > 0 && q.cutoff < 1, q.id);
    }
  }
});

test('a finding is decided by the question’s own cutoff, not even odds', () => {
  const low = questionById('obscured_intent');
  const high = questionById('too_many_arguments');

  assert.ok(low?.type === 'noul' && low.cutoff < 0.5);
  assert.ok(high?.type === 'noul' && high.cutoff > 0.5);
  assert.equal(isFinding('obscured_intent', low.cutoff), true);
  assert.equal(isFinding('obscured_intent', 0.4), true);
  assert.equal(isFinding('too_many_arguments', 0.52), false);
  assert.equal(isFinding('too_many_arguments', high.cutoff), true);
});

test('a defined question sends Jev what counts as yes and as no', () => {
  const asked = questionsOf(QUESTIONS).too_many_arguments as {
    criteria?: { true: string | null; false: string | null };
  };

  assert.match(asked.criteria?.true ?? '', /def f\(a, b, c\)/);
  assert.match(asked.criteria?.false ?? '', /call site/);
});

test('an undefined question sends no criteria', () => {
  assert.equal(
    'criteria' in (questionsOf(QUESTIONS).swallowed_errors as object),
    false,
  );
});
