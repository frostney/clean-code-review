/**
 * The hook itself needs a DOM and eve's session protocol to run, neither of
 * which this repository's tests have. These drive the functions the hook
 * hands each outcome to, with the page's inputs: a turn with no answers goes
 * through `staleJudgments` and `withUnanswered`, one with answers through
 * `recordJudgedFor` and `withJudgeTurn`, and the cost cap through
 * `withCapReached` over every code file on screen.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Answers } from '@/agent/lib/judging/schema';
import type { FileJudgment } from '@/agent/lib/review/review';

import {
  fileSummaryStatus,
  fileVerdict,
  NO_SUMMARY,
  smellCount,
  verdictScore,
} from './display';
import {
  type LocalPause,
  outdatedParagraphs,
  type ReviewState,
  recordJudgedFor,
  staleJudgments,
  withCapReached,
  withJudgeTurn,
  withoutJudgments,
  withoutStalePaths,
  withUnanswered,
} from './useReview';

const judged: FileJudgment = {
  answers: { verdict: { score: 4, type: 'score' } },
  ms: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
};

const A = 'const a = 1;';
const B = 'const a = 2;';

/** One file on screen, judged when its code was A, with a turn in flight for it. */
function heldFor(): ReviewState {
  return {
    asking: true,
    budgetSpent: false,
    cached: false,
    error: null,
    givenUp: {},
    judgments: { 'a.ts': judged },
    lastTurnMs: null,
    paused: null,
    pausedFiles: {},
    pending: { 'a.ts': true },
    spentUsd: 0,
    stalled: {},
    summary: { ...NO_SUMMARY, files: { 'a.ts': 'About A.' } },
  };
}

const judgedFor = new Map([['a.ts', A]]);
const onScreen = (content: string) => new Map([['a.ts', content]]);

/** What the card and the file list show for `a.ts`. */
function shown(s: ReviewState) {
  return fileVerdict(verdictScore(s.judgments['a.ts']?.answers), {
    failed: s.givenUp['a.ts'] === true,
    paused: s.pausedFiles['a.ts'] === true && s.pending['a.ts'] !== true,
    stalled: s.stalled['a.ts'] === true && s.pending['a.ts'] !== true,
  }).key;
}

const pause: LocalPause = {
  kind: 'paused',
  resetsAt: new Date(0).toISOString(),
  resumeAt: 0,
  waitMs: 0,
  window: 'day',
};

test('an edit whose turn throws loses the verdict of the old code', () => {
  const stale = staleJudgments(['a.ts'], judgedFor, onScreen(B));
  const next = withUnanswered(
    heldFor(),
    ['a.ts'],
    { kind: 'thrown', message: 'HTTP 502' },
    stale,
  );

  assert.deepEqual(stale, ['a.ts']);
  assert.equal(next.judgments['a.ts'], undefined);
  assert.equal(next.summary.files['a.ts'], undefined);
  assert.equal(shown(next), 'failed');
  assert.equal(next.error, 'HTTP 502');
});

test('an edit refused by the budget shows Paused, not the old verdict', () => {
  const stale = staleJudgments(['a.ts'], judgedFor, onScreen(B));
  const next = withUnanswered(
    heldFor(),
    ['a.ts'],
    { kind: 'paused', pause },
    stale,
  );

  assert.equal(next.judgments['a.ts'], undefined);
  assert.equal(shown(next), 'paused');
});

test('undone to the judged code while its turn fails, the verdict stays', () => {
  // The turn carried B; the reader went back to A before it failed.
  const stale = staleJudgments(['a.ts'], judgedFor, onScreen(A));
  const next = withUnanswered(
    heldFor(),
    ['a.ts'],
    { costUsd: 0, kind: 'failed' },
    stale,
  );

  assert.deepEqual(stale, []);
  assert.equal(next.judgments['a.ts'], judged);
  assert.equal(shown(next), 'approved');
});

/** What the card shows for `path`. */
function shownFor(s: ReviewState, path: string) {
  return fileVerdict(verdictScore(s.judgments[path]?.answers), {
    failed: s.givenUp[path] === true,
    paused: s.pausedFiles[path] === true && s.pending[path] !== true,
    stalled: s.stalled[path] === true && s.pending[path] !== true,
  }).key;
}

/** Hits the cap as the hook does: the turn's own files, then every file on screen. */
function capped(
  s: ReviewState,
  turn: readonly string[],
  judgedForNow: ReadonlyMap<string, string>,
  screen: ReadonlyMap<string, string>,
) {
  const afterTurn = withUnanswered(
    s,
    turn,
    { costUsd: 0, kind: 'spent' },
    staleJudgments(turn, judgedForNow, screen),
  );
  const everyFile = [...screen.keys()];

  return withCapReached(
    afterTurn,
    everyFile,
    staleJudgments(everyFile, judgedForNow, screen),
  );
}

test('at the cap, a file edited while the last turn ran loses its old verdict', () => {
  // The turn carried a.ts; b.ts was edited meanwhile and queued behind it.
  const s = { ...heldFor(), judgments: { 'a.ts': judged, 'b.ts': judged } };
  const next = capped(
    s,
    ['a.ts'],
    new Map([
      ['a.ts', A],
      ['b.ts', A],
    ]),
    new Map([
      ['a.ts', A],
      ['b.ts', B],
    ]),
  );

  assert.equal(next.budgetSpent, true);
  assert.equal(next.judgments['a.ts'], judged);
  assert.equal(next.judgments['b.ts'], undefined);
  assert.equal(shownFor(next, 'b.ts'), 'failed');
});

test('at the cap, a file never answered is given up on, not left judging', () => {
  const s = { ...heldFor(), judgments: {}, pending: { 'c.ts': true as const } };
  const next = capped(s, ['c.ts'], new Map(), new Map([['c.ts', A]]));

  assert.equal(next.pending['c.ts'], undefined);
  assert.equal(shownFor(next, 'c.ts'), 'failed');
  assert.equal(fileSummaryStatus(next.summary, 'c.ts'), 'failed');
});

test('past the cap, an edit loses the old verdict at once', () => {
  // What the files effect does on every change once the cap is reached.
  const s = { ...heldFor(), budgetSpent: true, pending: {} };
  const screen = onScreen(B);
  const next = withCapReached(
    s,
    ['a.ts'],
    staleJudgments(['a.ts'], judgedFor, screen),
  );

  assert.equal(next.judgments['a.ts'], undefined);
  assert.equal(shownFor(next, 'a.ts'), 'failed');
});

test('a judgment is remembered as made for the code sent, not the code shown', () => {
  const remembered = new Map<string, string>();

  // The reader typed on while the turn ran; the answer is still about A.
  recordJudgedFor(remembered, { 'a.ts': judged }, new Map([['a.ts', A]]));

  assert.equal(remembered.get('a.ts'), A);
  assert.deepEqual(staleJudgments(['a.ts'], remembered, onScreen(B)), ['a.ts']);
});

test('a judge turn that gives up on an edited file drops its old verdict', () => {
  const s = {
    ...heldFor(),
    judgments: { 'a.ts': judged, 'b.ts': judged },
    pending: { 'a.ts': true as const, 'b.ts': true as const },
  };
  const fresh = { 'b.ts': { ...judged, answers: {} } };
  const next = withJudgeTurn(s, {
    cached: false,
    costUsd: 0,
    failed: ['a.ts'],
    fresh,
    ms: 1,
    paths: ['a.ts', 'b.ts'],
    review: { files: fresh, model: 'jev', usage: judged.usage },
    stale: ['a.ts'],
    unjudged: 1,
  });

  assert.equal(next.judgments['a.ts'], undefined);
  assert.equal(next.summary.files['a.ts'], undefined);
  assert.equal(next.judgments['b.ts'], fresh['b.ts']);
  assert.equal(shownFor(next, 'a.ts'), 'failed');
  assert.equal(next.error, null);
});

test('a stale judgment leaves no verdict or paragraph behind', () => {
  const state = {
    ...heldFor(),
    judgments: { 'a.ts': judged, 'b.ts': judged },
    summary: {
      ...NO_SUMMARY,
      files: { 'a.ts': 'Old words.', 'b.ts': 'Kept.' },
      incomplete: { 'a.ts': true as const },
    },
  };
  const next = withoutJudgments(state, ['a.ts']);

  assert.deepEqual(Object.keys(next.judgments), ['b.ts']);
  assert.deepEqual(next.summary.files, { 'b.ts': 'Kept.' });
  assert.deepEqual(next.summary.incomplete, {});
});

test('past the cap, emptying a file takes its old answers and paragraph away', () => {
  const smelly: FileJudgment = {
    ...judged,
    answers: { ...judged.answers, magic_numbers: { noul: 0.9, type: 'noul' } },
  };
  const s: ReviewState = {
    ...heldFor(),
    budgetSpent: true,
    judgments: { 'a.ts': smelly, 'b.ts': judged },
    pending: {},
    summary: {
      ...NO_SUMMARY,
      files: { 'a.ts': 'About A.', 'b.ts': 'About B.' },
    },
  };
  // The files effect: prune what was emptied, then settle the cap over the
  // code files still on screen.
  const emptied = withoutStalePaths(s, (path) => path === 'a.ts');
  const next = withCapReached(emptied, ['b.ts'], []);

  assert.equal(next.judgments['a.ts'], undefined);
  assert.equal(next.summary.files['a.ts'], undefined);
  // What `ReviewPills` sums: only the file still holding answers.
  assert.equal(
    Object.values(next.judgments).reduce(
      (n, j) => n + smellCount(j.answers),
      0,
    ),
    smellCount(judged.answers),
  );
  assert.equal(next.judgments['b.ts'], judged);

  // Typed back in: no answer will come past the cap, so it is given up on.
  const refilled = withCapReached(next, ['a.ts', 'b.ts'], []);

  assert.equal(shownFor(refilled, 'a.ts'), 'failed');
});

test('past the cap, a paragraph about earlier answers is not shown as current', () => {
  const before = { verdict: { score: 4, type: 'score' as const } };
  const rejudged: FileJudgment = {
    ...judged,
    answers: { verdict: { score: 1, type: 'score' } },
  };
  const s: ReviewState = {
    ...heldFor(),
    judgments: { 'a.ts': rejudged, 'b.ts': judged },
    pending: {},
    summary: {
      ...NO_SUMMARY,
      files: { 'a.ts': 'Written for the old answers.', 'b.ts': 'Current.' },
    },
  };
  // Luna last wrote about a.ts's old answers; b.ts's paragraph is current.
  const summarized = new Map<string, Answers>([
    ['a.ts', before],
    ['b.ts', judged.answers],
  ]);
  const outdated = outdatedParagraphs(
    ['a.ts', 'b.ts'],
    summarized,
    s.judgments,
  );
  const next = withCapReached(s, ['a.ts', 'b.ts'], [], outdated);

  assert.deepEqual(outdated, ['a.ts']);
  assert.equal(next.summary.files['a.ts'], undefined);
  assert.equal(fileSummaryStatus(next.summary, 'a.ts'), 'failed');
  assert.equal(next.summary.files['b.ts'], 'Current.');
  // The verdict itself is about the code on screen and stays.
  assert.equal(next.judgments['a.ts'], rejudged);
});
