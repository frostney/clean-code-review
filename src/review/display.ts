import { type Question, SMELL_IDS } from '@/agent/lib/judging/questions';
import type { Answer, Answers } from '@/agent/lib/judging/schema';
import type { Summary } from '@/agent/lib/review/summary';

const PERCENT = 100;

/** A yes/no probability at or above this reads as "yes". */
const EVEN_ODDS = 0.5;

export function pct(p: number): string {
  return `${Math.round(p * PERCENT)}%`;
}

export function levelsOf(meta: Question): readonly string[] {
  return meta.type === 'score' ? meta.levels : [];
}

function nearestLevel(levels: readonly string[], score: number): string {
  const i = Math.max(0, Math.min(levels.length - 1, Math.round(score)));
  return levels[i];
}

export function headline(meta: Question, answer: Answer | undefined): string {
  if (!answer) {
    return '—';
  }
  if (answer.type === 'noul') {
    return answer.noul >= EVEN_ODDS ? 'Yes' : 'No';
  }
  // No question asks for a choice, but the payload schema still accepts one,
  // so print it rather than drop the row.
  if (answer.type === 'choice') {
    return answer.choice;
  }
  const levels = levelsOf(meta);
  return levels.length
    ? nearestLevel(levels, answer.score)
    : answer.score.toFixed(2);
}

/** Confidence is optional for scores and choices, so this may be empty. */
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

const NOUL_SHIFT = 0.15;

/** In levels. */
const SCORE_SHIFT = 0.75;

// Deliberately coarse: a bar that twitches on every pause teaches nothing.
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

/** e.g. "45% → 73%"; empty when there is nothing to show. */
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
  // A choice flip flashes but prints no delta: the new headline says it all.
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
  // Grey like empty, failed and pending: none is a verdict about the code.
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

/** 0 = "Rewrite it", 4 = "Ship it". */
const TOP_SCORE = 4;

const APPROVE_AT = 3;
const TIDY_AT = 1.5;

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

// A card with no answer coming must not keep saying "Judging…".
export function fileVerdict(
  score: number | null,
  state: {
    empty?: boolean;
    failed?: boolean;
    paused?: boolean;
    stalled?: boolean;
  },
): Verdict {
  if (state.empty) {
    return VERDICTS.empty;
  }
  if (score === null && state.failed) {
    return VERDICTS.failed;
  }
  // Paused wins over stalled: the budget reset will ask again by itself.
  if (score === null && state.paused) {
    return VERDICTS.paused;
  }
  if (score === null && state.stalled) {
    return VERDICTS.failed;
  }
  return verdictOf(score);
}

/**
 * Mean of the files that have a score. A prose-only change never starts a
 * judging turn, so it must not show "Judging…".
 */
export function reviewVerdict(
  scores: readonly (number | null)[],
  judgeable: boolean,
  paused = false,
  stalled = false,
): Verdict {
  if (!judgeable) {
    return VERDICTS.empty;
  }
  const mean = meanVerdict(scores);
  if (mean === null && paused) {
    return VERDICTS.paused;
  }
  return mean === null && stalled ? VERDICTS.failed : verdictOf(mean);
}

export function verdictScore(answers: Answers | undefined): number | null {
  const answer = answers?.verdict;
  return answer?.type === 'score' ? answer.score : null;
}

export function verdictConfidence(answers: Answers | undefined): number | null {
  const answer = answers?.verdict;
  return answer?.type === 'score' && answer.confidence !== undefined
    ? answer.confidence
    : null;
}

function meanVerdict(scores: readonly (number | null)[]): number | null {
  const known = scores.filter((s): s is number => s !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}

/** 0–1. */
export function verdictFill(score: number | null): number {
  return score === null ? 0 : Math.max(0, Math.min(1, score / TOP_SCORE));
}

/* ── Smells ─────────────────────────────────────────────────────────────── */

function isFinding(answer: Answer | undefined): boolean {
  return answer?.type === 'noul' && answer.noul >= EVEN_ODDS;
}

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
 *  - pending:   nothing written yet; a turn is or will be running
 *  - streaming: this block's text is arriving
 *  - stale:     previous text shown while a fresh review is written
 *  - ready:     settled text
 *  - failed:    a turn ended without text for this block
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
  /** Kept for files a re-run did not replace. */
  files: Record<string, string>;
  running: boolean;
  /** Text is arriving; the fields above are a partial parse. */
  streaming: boolean;
  /** "overall", a path, or null. */
  writing: string | null;
  replacing: Record<string, true>;
  /** At least one summarize turn has settled for this review. */
  settled: boolean;
  /** The last turn ended with nothing to show and none is queued. */
  failed: boolean;
  error: string | null;
  model: string | null;
  /** From the agent's one-hour cache rather than a Luna call. */
  cached: boolean;
  /** "overall" or paths where Luna hit its output ceiling twice. */
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
  // A settled review without an overall will not write one later.
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
  return summary.failed || summary.settled ? 'failed' : 'pending';
}

/** Whether the streaming caret belongs at the end of this block. */
export function isWriting(summary: SummaryView, block: string): boolean {
  return summary.streaming && summary.writing === block;
}
