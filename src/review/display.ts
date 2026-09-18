import { type Question, SMELL_IDS } from '@/agent/lib/judging/questions';
import type { Answer, Answers } from '@/agent/lib/judging/schema';
import type { Summary } from '@/agent/lib/review/summary';

/** Probabilities are stored 0–1 and read as whole percents. */
const PERCENT = 100;

/** Jev's yes/no answers are odds; at even odds or better the answer is "yes". */
const EVEN_ODDS = 0.5;

export function pct(p: number): string {
  return `${Math.round(p * PERCENT)}%`;
}

/** The levels of a score question, in order. */
export function levelsOf(meta: Question): readonly string[] {
  return meta.type === 'score' ? meta.levels : [];
}

/** The level a score landed closest to, so the number reads as a judgment. */
function nearestLevel(levels: readonly string[], score: number): string {
  const i = Math.max(0, Math.min(levels.length - 1, Math.round(score)));
  return levels[i];
}

/** The answer, in one word. */
export function headline(meta: Question, answer: Answer | undefined): string {
  if (!answer) {
    return '—';
  }
  if (answer.type === 'noul') {
    return answer.noul >= EVEN_ODDS ? 'Yes' : 'No';
  }
  // `choice` is no longer one of the question types; the payload schema still
  // tolerates one, so print it rather than dropping the row.
  if (answer.type === 'choice') {
    return answer.choice;
  }
  const levels = levelsOf(meta);
  return levels.length
    ? nearestLevel(levels, answer.score)
    : answer.score.toFixed(2);
}

/**
 * The number beside it, when there is one: a noul's probability of "yes", or
 * Jev's own certainty for a score or a choice, which it does not always report.
 */
export function detail(answer: Answer | undefined): string {
  if (!answer) {
    return '';
  }
  if (answer.type === 'noul') {
    return pct(answer.noul);
  }
  return answer.confidence === undefined
    ? ''
    : `${pct(answer.confidence)} sure`;
}

/** A yes/no answer has moved when its odds shifted by this much or more. */
const NOUL_SHIFT = 0.15;

/** A score has moved when it shifted by this much of a level or more. */
const SCORE_SHIFT = 0.75;

/**
 * Did this answer change enough to be worth the reader's attention? Thresholds
 * are deliberately coarse: a bar that twitches on every pause teaches nothing,
 * so we only flag flips and real moves.
 */
export function isMeaningful(
  prev: Answer | undefined,
  next: Answer | undefined,
): boolean {
  if (!prev || !next || prev.type !== next.type) {
    return false;
  }
  if (prev.type === 'noul' && next.type === 'noul') {
    return (
      prev.noul >= EVEN_ODDS !== next.noul >= EVEN_ODDS ||
      Math.abs(prev.noul - next.noul) >= NOUL_SHIFT
    );
  }
  if (prev.type === 'score' && next.type === 'score') {
    return Math.abs(prev.score - next.score) >= SCORE_SHIFT;
  }
  if (prev.type === 'choice' && next.type === 'choice') {
    return prev.choice !== next.choice;
  }
  return false;
}

/** "45% → 73%" — the receipt for a flash. Empty when there's nothing to show. */
export function deltaText(meta: Question, prev: Answer, next: Answer): string {
  if (prev.type === 'noul' && next.type === 'noul') {
    return `${pct(prev.noul)} → ${pct(next.noul)}`;
  }
  if (prev.type === 'score' && next.type === 'score') {
    const levels = levelsOf(meta);
    if (!levels.length) {
      return '';
    }
    const from = nearestLevel(levels, prev.score);
    const to = nearestLevel(levels, next.score);
    return from === to ? '' : `${from} → ${to}`;
  }
  // A choice flip flashes the row but prints no delta: the new headline is
  // already the whole story, and "Exceptions → Result types" would only repeat it.
  return '';
}

/* ── Verdicts ───────────────────────────────────────────────────────────── */

type VerdictKey =
  | 'approved'
  | 'tidy'
  | 'changes'
  | 'pending'
  | 'failed'
  | 'paused'
  | 'empty';

export interface Verdict {
  key: VerdictKey;
  label: string;
  /** Tailwind classes for the badge, from the palette in globals.css. */
  className: string;
}

const VERDICTS: Record<VerdictKey, Verdict> = {
  approved: {
    className: 'bg-ok-bg text-ok',
    key: 'approved',
    label: 'Approved',
  },
  changes: {
    className: 'bg-bad-bg text-bad',
    key: 'changes',
    label: 'Changes requested',
  },
  empty: {
    className: 'bg-track text-muted',
    key: 'empty',
    label: 'Nothing to judge',
  },
  failed: {
    className: 'bg-track text-muted',
    key: 'failed',
    label: 'Could not judge',
  },
  // Not judgments: the ways a card ends up with no answers and no reason to
  // keep pulsing. Grey, because none is a verdict about the code.
  paused: {
    className: 'bg-track text-muted',
    key: 'paused',
    label: 'Paused',
  },
  pending: {
    className: 'bg-track text-muted',
    key: 'pending',
    label: 'Judging…',
  },
  tidy: {
    className: 'bg-warn-bg text-warn',
    key: 'tidy',
    label: 'Needs tidying',
  },
};

/** The top of the five-level verdict scale: 0 = "Rewrite it", 4 = "Ship it". */
const TOP_SCORE = 4;

/** At or above this the change is approved. */
const APPROVE_AT = 3;

/** At or above this it only needs tidying; below it, changes are requested. */
const TIDY_AT = 1.5;

/**
 * The verdict question answers on the same five-level scale as every other
 * score. These two cuts turn it into the three words a review ends with.
 */
function verdictOf(score: number | null): Verdict {
  if (score === null) {
    return VERDICTS.pending;
  }
  if (score >= APPROVE_AT) {
    return VERDICTS.approved;
  }
  if (score >= TIDY_AT) {
    return VERDICTS.tidy;
  }
  return VERDICTS.changes;
}

/**
 * The badge a file wears: its verdict, unless there is nothing to judge or the
 * judging did not come back — a card with no answer coming must not go on
 * saying "Judging…".
 */
export function fileVerdict(
  score: number | null,
  state: { empty?: boolean; failed?: boolean; paused?: boolean },
): Verdict {
  if (state.empty) {
    return VERDICTS.empty;
  }
  if (score === null && state.failed) {
    return VERDICTS.failed;
  }
  // The site's model budget refused the turn: nothing is coming until it resets.
  if (score === null && state.paused) {
    return VERDICTS.paused;
  }
  return verdictOf(score);
}

/**
 * The verdict for the review as a whole: the mean of the files that have one,
 * unless there is no code in the review at all. A change that is only
 * documentation never starts a judging turn, so "Judging…" would pulse for as
 * long as the tab is open; "Nothing to judge" is what is actually true.
 */
export function reviewVerdict(
  scores: readonly (number | null)[],
  judgeable: boolean,
  paused = false,
): Verdict {
  if (!judgeable) {
    return VERDICTS.empty;
  }
  const mean = meanVerdict(scores);
  return mean === null && paused ? VERDICTS.paused : verdictOf(mean);
}

/** The verdict score of one file, or null when Jev has not answered for it. */
export function verdictScore(answers: Answers | undefined): number | null {
  const answer = answers?.verdict;
  return answer?.type === 'score' ? answer.score : null;
}

/** Jev's own certainty about the verdict, when it reported one. */
export function verdictConfidence(answers: Answers | undefined): number | null {
  const answer = answers?.verdict;
  return answer?.type === 'score' && answer.confidence !== undefined
    ? answer.confidence
    : null;
}

/** The review's verdict: the mean of the files that have one. */
function meanVerdict(scores: readonly (number | null)[]): number | null {
  const known = scores.filter((s): s is number => s !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}

/** How full a verdict bar is: the score's position on its five levels. */
export function verdictFill(score: number | null): number {
  return score === null ? 0 : Math.max(0, Math.min(1, score / TOP_SCORE));
}

/* ── Smells ─────────────────────────────────────────────────────────────── */

/** A yes/no row is a finding when Jev puts "yes" at even odds or better. */
function isFinding(answer: Answer | undefined): boolean {
  return answer?.type === 'noul' && answer.noul >= EVEN_ODDS;
}

/** How many of the yes/no smell rows this file lit up. */
export function smellCount(answers: Answers | undefined): number {
  if (!answers) {
    return 0;
  }
  let n = 0;
  for (const id of SMELL_IDS) {
    if (isFinding(answers[id])) {
      n++;
    }
  }
  return n;
}

/** "7 smells", "1 smell", "no smells" — the count as a reader would say it. */
export function smellLabel(count: number): string {
  if (count === 0) {
    return 'no smells';
  }
  return count === 1 ? '1 smell' : `${count} smells`;
}

/* ── Luna's review ──────────────────────────────────────────────────────── */

export type Decision = Summary['decision'];

export const DECISIONS: Record<Decision, { label: string; className: string }> =
  {
    approve: { className: 'bg-ok-bg text-ok', label: 'Approve' },
    comment: { className: 'bg-track text-muted', label: 'Comment' },
    request_changes: {
      className: 'bg-bad-bg text-bad',
      label: 'Request changes',
    },
  };

/**
 * What one review block is doing right now.
 *
 *  - pending:   nothing written yet and something is (or will be) running
 *  - streaming: the reviewer is writing this block and its text is arriving
 *  - stale:     previous text on screen while a fresh review is being written
 *  - ready:     settled text
 *  - failed:    a review turn ended without text for this block
 */
export type SummaryStatus =
  | 'pending'
  | 'streaming'
  | 'ready'
  | 'stale'
  | 'failed';

export interface SummaryView {
  overall: string | null;
  decision: Decision | null;
  /** Path → that file's review. Kept for files a re-run did not replace. */
  files: Record<string, string>;
  /** A summarize turn is on the wire. */
  running: boolean;
  /** The reviewer's own text is arriving delta by delta; the fields above are a partial parse. */
  streaming: boolean;
  /** The block being written right now: "overall", a path, or null. A caret sits at its end. */
  writing: string | null;
  /** The paths the running turn will replace. */
  replacing: Record<string, true>;
  /** At least one summarize turn has settled for this review. */
  settled: boolean;
  /** The last summarize turn ended with nothing to show and none is queued. */
  failed: boolean;
  /** Why it ended that way, when the agent said: shown with the failure. */
  error: string | null;
  /** The model that wrote it, as the payload named it. */
  model: string | null;
  /** The review came back from the agent's one-hour cache rather than from Luna. */
  cached: boolean;
  /**
   * Blocks Luna was cut off in, having run into its output ceiling twice:
   * "overall" or a path. Their text is as far as it got.
   */
  incomplete: Record<string, true>;
}

export const NO_SUMMARY: SummaryView = {
  cached: false,
  decision: null,
  error: null,
  failed: false,
  files: {},
  incomplete: {},
  model: null,
  overall: null,
  replacing: {},
  running: false,
  settled: false,
  streaming: false,
  writing: null,
};

export function overallSummaryStatus(summary: SummaryView): SummaryStatus {
  if (summary.streaming) {
    return summary.overall ? 'streaming' : 'pending';
  }
  if (summary.running) {
    return summary.overall ? 'stale' : 'pending';
  }
  if (summary.overall) {
    return 'ready';
  }
  // A settled review that never wrote an overall will not write one later: the
  // spinner would spin for good. The same rule the file blocks follow.
  return summary.failed || summary.settled ? 'failed' : 'pending';
}

export function fileSummaryStatus(
  summary: SummaryView,
  path: string,
): SummaryStatus {
  const text = summary.files[path];
  if (summary.streaming && summary.replacing[path]) {
    return text ? 'streaming' : 'pending';
  }
  if (summary.running && summary.replacing[path]) {
    return text ? 'stale' : 'pending';
  }
  if (text) {
    return 'ready';
  }
  // A settled review that said nothing about this file will not say more later.
  return summary.failed || summary.settled ? 'failed' : 'pending';
}

/** True while the caret belongs at the end of this block's text. */
export function isWriting(summary: SummaryView, block: string): boolean {
  return summary.streaming && summary.writing === block;
}
