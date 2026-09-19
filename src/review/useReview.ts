'use client';

import type {
  Client,
  ClientSession,
  MessageResponse,
  MessageStreamEvent,
} from 'eve/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Answers } from '@/agent/lib/judging/schema';
import { judgeMessage, summarizeMessage } from '@/agent/lib/review/prompt';
import {
  type FileJudgment,
  isProsePath,
  REVIEW_LIMITS,
  type ReviewFile,
  type ReviewResult,
} from '@/agent/lib/review/review';
import {
  parseSummaryText,
  REVIEWER_MODEL,
  type Summary,
} from '@/agent/lib/review/summary';
import {
  mayBePaused,
  type PausedReply,
  parsePaused,
} from '@/agent/lib/spend/budgets';

import { isMeaningful, NO_SUMMARY, type SummaryView } from './display';

type TurnRuntime = typeof import('./turn-runtime')['turnRuntime'];

/** The runtime once it has arrived, for the one check that cannot wait for it. */
let turnRuntime: TurnRuntime | null = null;
let turnRuntimeLoading: Promise<TurnRuntime> | null = null;

/**
 * eve's client and the review parser, fetched the first time a review sends
 * anything. A page that never starts one never downloads either. A chunk that
 * failed to arrive is asked for again by the next turn rather than remembered.
 */
function loadTurnRuntime(): Promise<TurnRuntime> {
  turnRuntimeLoading ??= import('./turn-runtime').then(
    (module) => {
      turnRuntime = module.turnRuntime;
      return module.turnRuntime;
    },
    (err: unknown) => {
      turnRuntimeLoading = null;
      throw err;
    },
  );
  return turnRuntimeLoading;
}

/**
 * Long enough to coalesce a burst of keystrokes, short enough that a pause in
 * an editor feels answered. A turn is one Jev evaluation per file, all of them
 * in parallel, so this sits close to the pause a typist actually makes.
 */
const DEBOUNCE_MS = 300;

/**
 * How long after the last judgment landed before Luna is asked to write the
 * review again. Prose costs cents and takes seconds, so it waits for the code
 * to stop moving rather than chasing every pause the way the meters do.
 */
const SUMMARY_DEBOUNCE_MS = 2_000;

/**
 * A review that has not finished in a minute is not going to. One summarize
 * turn is a handful of parallel Luna calls that take seconds, so this is the
 * patience for a turn that has stopped rather than a budget for a slow one.
 */
const SUMMARY_TIMEOUT_MS = 60_000;

/** What a stalled review is called on screen. */
const SUMMARY_TIMEOUT_ERROR = 'the review took too long';

/**
 * The reviewer writes its decision on the first line, so the badge can be on
 * screen long before the prose is. The parser defaults to "comment" when there
 * is no decision yet, which is only worth showing once that line is finished.
 */
const DECISION_LINE = /\bdecision\b\s*[:：][^\n]*\n/i;

export interface ReviewState {
  /** The judgment for each path that has one. Kept while the next turn runs. */
  judgments: Record<string, FileJudgment>;
  /** Paths with a request in flight or queued behind one. */
  pending: Record<string, true>;
  /** Paths that came back unjudged twice and will not be asked about again. */
  failed: Record<string, true>;
  asking: boolean;
  error: string | null;
  /** Wall-clock time of the last settled turn, in milliseconds. */
  ms: number | null;
  /** Everything this tab's session has spent so far. */
  spentUsd: number;
  /** The session hit the agent's per-session cost cap and will not answer again. */
  budgetSpent: boolean;
  /**
   * The site's model budget for this hour or this UTC day is spent, and a
   * turn was refused with no model run: the last refusal, for the notice, set
   * while any file or the review is still waiting on it. Unlike `budgetSpent`
   * this passes: when the window resets the page asks again by itself.
   */
  paused: LocalPause | null;
  /** Paths a refused judge turn carried, waiting for the budget to reset. */
  pausedFiles: Record<string, true>;
  /**
   * Paths a turn failed for and let go: nothing asks about them again until
   * Retry or an edit sends them. Kept apart from `error`, which is only what
   * is said about it and can be put away without these starting to wait.
   */
  stalled: Record<string, true>;
  /** Every file of the last judge turn came back from the agent's one-hour cache. */
  cached: boolean;
  /** Luna's prose review of the whole change and of each file. */
  summary: SummaryView;
}

const IDLE: ReviewState = {
  asking: false,
  budgetSpent: false,
  cached: false,
  error: null,
  failed: {},
  judgments: {},
  ms: null,
  paused: null,
  pausedFiles: {},
  pending: {},
  spentUsd: 0,
  stalled: {},
  summary: NO_SUMMARY,
};

/** A refusal as this tab holds it: with when, by this tab's own clock, to ask again. */
export interface LocalPause extends PausedReply {
  /** `Date.now()` at which the window has reset by the server's clock. */
  resumeAt: number;
}

/**
 * How far past the reset a tab waits, at most, before asking again. Every
 * paused tab is told the same reset; without a spread they would all ask in
 * the same instant, which is the burst the spend brake counts worst.
 */
const RESUME_JITTER_MS = 60_000;

/**
 * The refusal, and when to ask again: the server's wait counted from when the
 * reply arrived, so a browser clock running ahead cannot read a reset still to
 * come as one already past, and a random moment of up to a minute after it.
 */
function localPause(reply: PausedReply): LocalPause {
  return {
    ...reply,
    resumeAt:
      Date.now() + reply.waitMs + Math.floor(Math.random() * RESUME_JITTER_MS),
  };
}

/** A turn's reply read as a refusal, as this tab holds one, or null when it is anything else. */
function pausedIn(text: string | null | undefined): LocalPause | null {
  const reply = parsePaused(text);
  return reply ? localPause(reply) : null;
}

/**
 * The shortest wait before asking again, whatever the reply said: a refusal
 * that came back with no wait at all, right on a window's edge, must not
 * become a turn per tick. Short, so the notice does not outlive its time.
 */
const MIN_RESUME_MS = 1000;

/** What a review that was refused for the site's budget says where its text would be. */
const PAUSED_SUMMARY_ERROR = 'the review budget is spent';

/** The review itself, rather than a file, is waiting on the budget. */
const summaryPaused = (s: ReviewState) =>
  s.summary.error === PAUSED_SUMMARY_ERROR;

/**
 * The notice stays while anything still waits on the budget, and goes with
 * the last thing that did: a turn that got through only clears what it carried.
 */
function withPauseReconciled(s: ReviewState): ReviewState {
  return s.paused && !Object.keys(s.pausedFiles).length && !summaryPaused(s)
    ? { ...s, paused: null }
    : s;
}

/** The pull request a review came from, when it came from one. */
export interface PullRequestContext {
  title: string;
  body?: string;
  url?: string;
}

/** Sum what one settled turn cost, over the model steps the runtime reported. */
function costOf(events: readonly { type: string; data?: unknown }[]): number {
  return events
    .filter((e) => e.type === 'step.completed')
    .reduce((total, e) => {
      const usage = (e.data as { usage?: { costUsd?: number } } | undefined)
        ?.usage;
      return total + (usage?.costUsd ?? 0);
    }, 0);
}

/**
 * The status line's side of an incomplete answer. A turn that judged every
 * file it was given says nothing; anything less says how much is missing,
 * because silently short answers are how a card gets stuck.
 */
function unjudgedError(
  review: ReviewResult | null,
  unjudged: number,
): string | null {
  if (!review) {
    return 'the reply was not a review';
  }
  if (!unjudged) {
    return null;
  }
  return `${unjudged} ${unjudged === 1 ? 'file' : 'files'} came back unjudged`;
}

function without(
  map: Record<string, true>,
  paths: readonly string[],
): Record<string, true> {
  const next = { ...map };
  for (const path of paths) {
    delete next[path];
  }
  return next;
}

/**
 * Is this file's judgment different enough to be worth paying for new prose?
 * The same threshold the meters flash on, plus any row that appeared or
 * changed type — a review written about answers that did not move would read
 * the same anyway.
 */
function judgmentMoved(before: Answers | undefined, after: Answers): boolean {
  if (!before) {
    return true;
  }
  for (const [id, answer] of Object.entries(after)) {
    const prev = before[id];
    if (!prev || prev.type !== answer.type) {
      return true;
    }
    if (isMeaningful(prev, answer)) {
      return true;
    }
  }
  return false;
}

/** Everything one settled turn reports, named from the response it arrives on. */
type TurnResult = Awaited<ReturnType<MessageResponse['result']>>;

/** What one summarize turn came back with, once its stream has ended. */
interface SummaryRun {
  /** Every delta so far: the text as the page renders it while it arrives. */
  buffer: string;
  /** The turn was dropped — by a judge turn, a new review, or the timeout. */
  cancelled: boolean;
  /** The completed message, which is the text the review settles on. */
  complete: string;
  costUsd: number;
  error: string | null;
  failed: boolean;
  /** eve parked the turn on the budget prompt, so nothing more will arrive. */
  parked: boolean;
  steps: number;
}

function emptyRun(): SummaryRun {
  return {
    buffer: '',
    cancelled: false,
    complete: '',
    costUsd: 0,
    error: null,
    failed: false,
    parked: false,
    steps: 0,
  };
}

/**
 * Fold one stream event into the run. Returns true when the stream is over for
 * this turn: cancelled, failed, parked on the budget prompt, or handed back.
 */
function applySummaryEvent(
  run: SummaryRun,
  event: MessageStreamEvent,
  onText: (buffer: string) => void,
): boolean {
  switch (event.type) {
    case 'step.completed':
      run.steps += 1;
      run.costUsd += event.data.usage?.costUsd ?? 0;
      return false;
    // The budget prompt: eve parked the turn waiting for an Approve/Stop we
    // will never send. Anything after this could only be parked too.
    case 'input.requested':
      run.parked = true;
      return true;
    case 'message.appended':
      run.buffer += event.data.messageDelta;
      onText(run.buffer);
      return false;
    case 'message.completed':
      run.complete = String(event.data.message ?? '');
      return false;
    case 'turn.cancelled':
      run.cancelled = true;
      return true;
    case 'turn.failed':
    case 'session.failed': {
      run.failed = true;
      const message = event.data.message.trim();
      if (message) {
        run.error ??= message;
      }
      return true;
    }
    case 'session.waiting':
      return true;
    default:
      return false;
  }
}

/**
 * Read one summarize turn's stream to its end, painting each delta as it lands
 * and folding the rest into `run`. The run is filled in place, so a stream that
 * throws half way through still carries what it cost and what it wrote.
 */
async function readSummaryStream(
  response: MessageResponse,
  run: SummaryRun,
  hooks: { isAborted: () => boolean; onText: (buffer: string) => void },
): Promise<void> {
  for await (const event of response) {
    // A cancel, a new review or an unmount: stop reading, stop painting.
    if (hooks.isAborted()) {
      run.cancelled = true;
      break;
    }
    if (applySummaryEvent(run, event, hooks.onText)) {
      break;
    }
  }
}

/**
 * The review a turn settles on, or null when the turn was dropped or wrote
 * nothing readable. Half a review is not one: a turn that was cancelled keeps
 * what is on screen rather than settling on the text it got as far as.
 */
function settledText(run: SummaryRun): Summary | null {
  if (run.cancelled || run.failed) {
    return null;
  }
  const next = parseSummaryText(run.complete || run.buffer);
  return next.overall || next.files.length ? next : null;
}

/**
 * The one section the reviewer is still writing: the section the text so far
 * ends in, while it belongs to this review, and otherwise the overall
 * paragraph once it has started. Not always the last file section: a part
 * written again repeats its sections from the first.
 */
function writingSection(
  parsed: Summary,
  asked: ReadonlySet<string>,
): string | null {
  if (parsed.writing !== null && asked.has(parsed.writing)) {
    return parsed.writing;
  }
  return parsed.overall ? OVERALL_BLOCK : null;
}

/** The review as it looks mid-stream, with the text written so far on screen. */
function withStreamedSummary(
  s: ReviewState,
  parsed: Summary,
  asked: ReadonlySet<string>,
  decisionSeen: boolean,
): ReviewState {
  const files = { ...s.summary.files };
  // A block this run has written anew says for itself whether it is cut
  // off; a "Cut off" from an earlier run belongs to text no longer shown.
  const incomplete = { ...s.summary.incomplete };
  for (const file of parsed.files) {
    if (asked.has(file.path)) {
      files[file.path] = file.summary;
      if (file.incomplete) {
        incomplete[file.path] = true;
      } else {
        delete incomplete[file.path];
      }
    }
  }
  if (parsed.overallIncomplete) {
    incomplete[OVERALL_BLOCK] = true;
  } else if (parsed.overall) {
    delete incomplete[OVERALL_BLOCK];
  }
  // The sections before the open one are done, so their cards stop waiting
  // for a rewrite. Those after it are the first try of a part being written
  // again, and are about to be replaced.
  const open = parsed.files.findIndex((f) => f.path === parsed.writing);
  const done = (open === -1 ? parsed.files : parsed.files.slice(0, open))
    .map((f) => f.path)
    .filter((path) => asked.has(path));
  return {
    ...s,
    summary: {
      ...s.summary,
      cached: false,
      decision: decisionSeen ? parsed.decision : s.summary.decision,
      files,
      incomplete,
      model: REVIEWER_MODEL,
      overall: parsed.overall || s.summary.overall,
      replacing: done.length
        ? without(s.summary.replacing, done)
        : s.summary.replacing,
      streaming: true,
      writing: writingSection(parsed, asked),
    },
  };
}

/** The review as it settles when the turn wrote something readable. */
function withSettledSummary(
  s: ReviewState,
  next: Summary,
  asked: ReadonlySet<string>,
  run: SummaryRun,
  cached: boolean,
): ReviewState {
  return withPauseReconciled({
    ...s,
    spentUsd: s.spentUsd + run.costUsd,
    summary: {
      ...s.summary,
      cached,
      decision: next.overall ? next.decision : s.summary.decision,
      error: null,
      failed: false,
      // Files this run did not carry keep the review they already had.
      files: {
        ...s.summary.files,
        ...Object.fromEntries(
          next.files
            .filter((f) => asked.has(f.path))
            .map((f) => [f.path, f.summary]),
        ),
      },
      incomplete: settledIncomplete(s.summary.incomplete, next, asked),
      model: REVIEWER_MODEL,
      overall: next.overall || s.summary.overall,
      replacing: {},
      running: false,
      settled: true,
      streaming: false,
      writing: null,
    },
  });
}

/** How the overall block is named among `SummaryView['incomplete']`, as in `writing`. */
const OVERALL_BLOCK = 'overall';

/**
 * Which blocks are cut off once a turn settles: whatever this turn rewrote
 * says so for itself, and the rest keep what they had.
 */
function settledIncomplete(
  before: Record<string, true>,
  next: Summary,
  asked: ReadonlySet<string>,
): Record<string, true> {
  const rewritten = next.files
    .filter((f) => asked.has(f.path))
    .map((f) => f.path);
  const kept = without(
    before,
    next.overall ? [...rewritten, OVERALL_BLOCK] : rewritten,
  );
  return {
    ...kept,
    ...Object.fromEntries(
      next.files
        .filter((f) => f.incomplete && asked.has(f.path))
        .map((f) => [f.path, true as const]),
    ),
    ...(next.overallIncomplete ? { [OVERALL_BLOCK]: true as const } : {}),
  };
}

/**
 * The review as it settles when the turn was dropped or wrote nothing. A review
 * dropped for a judge turn is not a failure — newer answers are already on the
 * wire and the review will be asked for again.
 */
function withAbandonedSummary(
  s: ReviewState,
  run: SummaryRun,
  error: string | null,
  retrying: boolean,
): ReviewState {
  return withPauseReconciled({
    ...s,
    spentUsd: s.spentUsd + run.costUsd,
    summary: {
      ...s.summary,
      error: retrying ? null : error,
      failed: !retrying,
      replacing: {},
      running: false,
      streaming: false,
      writing: null,
    },
  });
}

/**
 * The review as it stops, because the site's budget refused the turn. Whatever
 * prose is on screen stays; what was not written yet says why it is not there.
 */
function withPausedSummary(
  s: ReviewState,
  run: SummaryRun,
  paused: LocalPause,
): ReviewState {
  return {
    ...s,
    paused,
    spentUsd: s.spentUsd + run.costUsd,
    summary: {
      ...s.summary,
      error: PAUSED_SUMMARY_ERROR,
      failed: true,
      replacing: {},
      running: false,
      streaming: false,
      writing: null,
    },
  };
}

/** The review as it stops, because the session hit its cost cap mid-turn. */
function withBudgetSpentSummary(s: ReviewState, costUsd: number): ReviewState {
  return {
    ...s,
    budgetSpent: true,
    spentUsd: s.spentUsd + costUsd,
    summary: {
      ...s.summary,
      replacing: {},
      running: false,
      streaming: false,
      writing: null,
    },
  };
}

/**
 * The judgments of one turn that are still about the code on screen. A file
 * whose text moved on while the turn ran was judged on something nobody can
 * see any more: the money was spent, but the answers are stale.
 */
function freshJudgments(
  review: ReviewResult | null,
  sent: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): Record<string, FileJudgment> {
  const fresh: Record<string, FileJudgment> = {};
  for (const [path, judgment] of Object.entries(review?.files ?? {})) {
    if (current.get(path) !== sent.get(path)) {
      continue;
    }
    if (!Object.keys(judgment.answers).length) {
      continue;
    }
    fresh[path] = judgment;
  }
  return fresh;
}

/** What one judge turn came back with, once it is merged into the page by path. */
interface JudgeTurn {
  cached: boolean;
  /** What the turn cost, to add to what this tab's session has spent. */
  costUsd: number;
  /** Paths given up on: unanswered twice running. */
  failed: readonly string[];
  fresh: Record<string, FileJudgment>;
  ms: number;
  paths: readonly string[];
  review: ReviewResult | null;
  unjudged: number;
}

/** The turn the session's cost cap stopped, with the paths it carried freed. */
function withBudgetSpentTurn(
  s: ReviewState,
  paths: readonly string[],
  costUsd: number,
): ReviewState {
  return {
    ...s,
    asking: false,
    budgetSpent: true,
    pending: without(s.pending, paths),
    spentUsd: s.spentUsd + costUsd,
  };
}

/**
 * A judge turn the site's budget refused: nothing was judged and nothing was
 * spent, the paths it carried wait for the budget to reset, and the answers
 * already on screen stay put.
 */
function withPausedTurn(
  s: ReviewState,
  paths: readonly string[],
  paused: LocalPause,
): ReviewState {
  return {
    ...s,
    asking: false,
    paused,
    pausedFiles: {
      ...s.pausedFiles,
      ...Object.fromEntries(paths.map((p) => [p, true as const])),
    },
    pending: without(s.pending, paths),
  };
}

/** A judge turn that judged nothing: refused for the budget, or not answered at all. */
function withUnansweredTurn(
  s: ReviewState,
  paths: readonly string[],
  paused: LocalPause | null,
  costUsd: number,
): ReviewState {
  return paused
    ? withPausedTurn(s, paths, paused)
    : withFailedTurn(s, paths, costUsd);
}

/** A turn the agent could not answer at all. */
function withFailedTurn(
  s: ReviewState,
  paths: readonly string[],
  costUsd: number,
): ReviewState {
  return withPauseReconciled({
    ...s,
    asking: false,
    error: 'the agent could not answer',
    pausedFiles: without(s.pausedFiles, paths),
    pending: without(s.pending, paths),
    spentUsd: s.spentUsd + costUsd,
    stalled: {
      ...s.stalled,
      ...Object.fromEntries(paths.map((p) => [p, true as const])),
    },
  });
}

/** One settled judge turn: its answers merged in, its paths no longer pending. */
function withJudgeTurn(s: ReviewState, turn: JudgeTurn): ReviewState {
  return withPauseReconciled({
    ...s,
    asking: false,
    cached: turn.cached,
    error: unjudgedError(turn.review, turn.unjudged),
    failed: {
      ...without(s.failed, turn.paths),
      ...Object.fromEntries(turn.failed.map((p) => [p, true as const])),
    },
    judgments: { ...s.judgments, ...turn.fresh },
    ms: turn.ms,
    pausedFiles: without(s.pausedFiles, turn.paths),
    pending: without(s.pending, turn.paths),
    spentUsd: s.spentUsd + turn.costUsd,
  });
}

/** Drop every key of `map` whose path no longer belongs to the review. */
function pruneKeys(
  map: { keys(): Iterable<string>; delete(key: string): unknown },
  stale: (path: string) => boolean,
): void {
  for (const path of [...map.keys()]) {
    if (stale(path)) {
      map.delete(path);
    }
  }
}

/** Forget everything the state still holds about files that have left the review. */
function withoutStalePaths(
  s: ReviewState,
  stale: (path: string) => boolean,
): ReviewState {
  const gone = Object.keys(s.judgments).filter(stale);
  const orphaned = Object.keys(s.pending).filter(stale);
  const cleared = Object.keys(s.failed).filter(stale);
  const notes = Object.keys(s.summary.files).filter(stale);
  const waiting = Object.keys(s.pausedFiles).filter(stale);
  if (
    !gone.length &&
    !orphaned.length &&
    !cleared.length &&
    !notes.length &&
    !waiting.length
  ) {
    return s;
  }
  const judgments = { ...s.judgments };
  for (const path of gone) {
    delete judgments[path];
  }
  const summaryFiles = { ...s.summary.files };
  for (const path of notes) {
    delete summaryFiles[path];
  }
  return withPauseReconciled({
    ...s,
    failed: without(s.failed, cleared),
    judgments,
    pausedFiles: without(s.pausedFiles, waiting),
    pending: without(s.pending, orphaned),
    summary: {
      ...s.summary,
      files: summaryFiles,
      incomplete: without(s.summary.incomplete, notes),
    },
  });
}

/**
 * The code files whose text on screen is not what was last sent, which is
 * what a turn asks about. An empty file is not a question; Jev is never asked
 * about one. Nor is prose: a README is on the page for reading, not judging.
 */
function unsent(
  files: readonly ReviewFile[],
  sent: ReadonlyMap<string, string>,
): ReviewFile[] {
  return files
    .filter(
      (f) =>
        !isProsePath(f.path) &&
        f.content.trim() &&
        sent.get(f.path) !== f.content,
    )
    .slice(0, REVIEW_LIMITS.maxFiles);
}

/** What the page can do about a turn that failed. */
export interface ReviewActions {
  /**
   * Ask again about every file the failed turn left without an answer.
   * False when there was nothing to ask about.
   */
  retry: () => boolean;
}

/**
 * Judge a set of files, and re-judge whichever of them changes.
 *
 * One tab, one durable eve session, one turn in flight. The first turn carries
 * every file; an edit carries only the file that was edited, and the judgment
 * that comes back is merged into the map by path — so a card whose code did
 * not move keeps the answers it already had, and its meters do not flash.
 *
 * Each turn clears the session's history first. The questions are about *these*
 * files, and a transcript of earlier ones would let the model anchor on code
 * that is no longer on screen.
 *
 * Two kinds of turn share that session and take it in turns. A **judge** turn
 * is Jev answering the questions. A **summarize** turn hands the files and
 * those answers to the agent, and its reply *is* Luna's review: the text
 * streams back on the turn's own response, delta by delta, and is re-parsed on
 * every one of them so the decision, the overall paragraph and each file's
 * note appear as they are written. A review the agent already had written down
 * arrives the same way, only at once and for nothing. A judge turn always
 * wins: starting one cancels a summary in flight, because the answers it is
 * about to change are the ones that summary was written from.
 *
 * When the agent's per-session cost cap is reached, eve pauses the turn and
 * asks the user to approve or stop (an `input.requested` event). A demo has
 * nobody to ask, so that is simply the end: the hook stops asking and the last
 * judgments stay frozen on screen.
 */
export function useReview(
  reviewId: string,
  files: readonly ReviewFile[],
  pr?: PullRequestContext,
): { state: ReviewState; actions: ReviewActions } {
  const [state, setState] = useState<ReviewState>(IDLE);

  /**
   * A different review must never be shown against the last one's prose, not
   * even for a frame. An effect is a frame too late: the cards of the new files
   * would render first, find a settled summary with nothing to say about their
   * paths, and read "No review yet" until the reset landed. Resetting here — in
   * the render that carries the new files — is what keeps that frame from
   * existing, because React re-runs this component before it renders any of
   * them. What the session has spent survives: the budget is the tab's, not the
   * review's.
   */
  const [shownReviewId, setShownReviewId] = useState(reviewId);
  if (reviewId !== shownReviewId) {
    setShownReviewId(reviewId);
    setState((s) => ({
      ...s,
      cached: false,
      error: null,
      failed: {},
      judgments: {},
      ms: null,
      // What waited on the budget belonged to the last review. This one's
      // first turn finds out afresh, and is served if it is all cached.
      paused: null,
      pausedFiles: {},
      pending: {},
      stalled: {},
      summary: NO_SUMMARY,
    }));
  }

  const clientRef = useRef<Client | null>(null);
  const sessionRef = useRef<ClientSession | null>(null);
  const inFlightRef = useRef(false);
  /** Path → the content last put on the wire for it. */
  const sentRef = useRef(new Map<string, string>());
  /** Files that changed while a turn was running, newest content per path. */
  const queuedRef = useRef(new Map<string, ReviewFile>());
  /** Path → how many turns in a row came back with no judgment for it. */
  const unjudgedRef = useRef(new Map<string, number>());
  /** The files on screen right now, so a turn can tell whether it is stale. */
  const filesRef = useRef<readonly ReviewFile[]>(files);
  const budgetSpentRef = useRef(false);

  /** The judgments as the turns know them, without waiting for a render. */
  const judgmentsRef = useRef<Record<string, FileJudgment>>({});
  /** Path → the answers the last summarize turn was sent for that file. */
  const summarizedRef = useRef(new Map<string, Answers>());
  const summaryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Dropped when the running summary stops being worth reading: a cancel, a
   * new review or an unmount. The turn's own stream takes no signal, so this
   * is what stops the page painting what is still arriving on it.
   */
  const summaryAbortRef = useRef<AbortController | null>(null);
  const summaryRunningRef = useRef(false);
  /** A summary is due but the session is busy; start it when the session frees. */
  const summaryWantedRef = useRef(false);
  /** The first summary of a review runs the moment its judgments land. */
  const summarizedOnceRef = useRef(false);
  /**
   * The review the turns are running for. A summarize turn captures it on the
   * way out and drops its result if it has changed — prose about the previous
   * review's files would otherwise land on this one's.
   */
  const reviewGenRef = useRef(reviewId);
  /** A cancel on the wire, so the next turn queues behind it rather than racing it. */
  const cancellingRef = useRef<Promise<void> | null>(null);
  /** The running summarize turn has already been asked to stop; asking twice is noise. */
  const cancelRequestedRef = useRef(false);
  const prRef = useRef<PullRequestContext | undefined>(pr);
  prRef.current = pr;
  /** The state as last rendered, for the resume timer, which runs outside any render. */
  const stateRef = useRef(state);
  stateRef.current = state;

  const client = useCallback(async (): Promise<Client> => {
    if (!clientRef.current) {
      const runtime = await loadTurnRuntime();
      // Same origin: `withEve` mounts the agent at /eve/v1 on this very host.
      clientRef.current ??= new runtime.Client({ host: '' });
    }
    return clientRef.current;
  }, []);

  /**
   * Put one turn down the tab's session: clear the history first, because the
   * questions are about *these* files, then send — opening a session when
   * there is none, or when the one we had has expired.
   */
  const sendTurn = useCallback(
    async (message: string) => {
      if (sessionRef.current) {
        // An expired session reports `no_active_session` rather than throwing,
        // and its id is retired: a send() on it would. Drop it and start over.
        const cleared = await sessionRef.current.clear();
        if (cleared.status === 'no_active_session') {
          sessionRef.current = null;
        }
      }
      if (sessionRef.current) {
        const session = sessionRef.current;
        return { response: await session.send(message), session };
      }
      const created = await (await client()).sessions.create({ message });
      sessionRef.current = created.session;
      return { response: created.response, session: created.session };
    },
    [client],
  );

  // A durable session outlives the tab that opened it: left alone it sits on
  // the server until sessionTimeoutMs. Retire it on the way out, fire and
  // forget — `keepalive` is what lets the request survive the unload.
  useEffect(() => {
    function onPageHide() {
      const session = sessionRef.current;
      if (!session) {
        return;
      }
      sessionRef.current = null;
      fetch(
        `/eve/v1/session/${encodeURIComponent(session.state.sessionId)}/reset`,
        {
          body: JSON.stringify({ reason: 'tab closed' }),
          headers: { 'content-type': 'application/json' },
          keepalive: true,
          method: 'POST',
        },
      ).catch(() => {
        /* The tab is leaving; there is nobody left to tell. */
      });
    }
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  /** What runs next once a turn settles: queued judge work first, then prose. */
  const drainRef = useRef<() => void>(() => {
    /* Replaced below, before any turn can settle. */
  });

  const scheduleSummary = useCallback((delay: number) => {
    if (summaryTimerRef.current) {
      clearTimeout(summaryTimerRef.current);
    }
    summaryTimerRef.current = setTimeout(() => {
      summaryTimerRef.current = null;
      summaryWantedRef.current = true;
      drainRef.current();
    }, delay);
  }, []);

  /**
   * Cancel the summarize turn that is running. The turn ends with
   * `turn.cancelled`, its Luna calls are aborted with it, and the session takes
   * the next turn straight away.
   *
   * Throws if the request itself failed: a caller about to send a turn on this
   * session wants to know it is sending into a session that is still busy.
   * Until it settles it is parked in `cancellingRef`, so eve hears "drop that
   * turn" before it hears "here is the next one".
   */
  const cancelSummary = useCallback(async () => {
    const session = sessionRef.current;
    if (!summaryRunningRef.current || !session) {
      return;
    }
    // Opening a review and sending the next judge turn both cancel the summary
    // that is running, and they happen together. The turn is only dropped once,
    // so the second caller waits for the first request rather than sending its own.
    if (cancelRequestedRef.current) {
      await cancellingRef.current;
      return;
    }
    cancelRequestedRef.current = true;
    const pending = session.cancel();
    // Nothing the turn is still writing belongs on screen.
    summaryAbortRef.current?.abort();
    const settled: Promise<void> = pending.then(
      () => {
        /* Dropped: the turn is gone either way. */
      },
      () => {
        /* Not dropped: the caller below is the one that hears about it. */
      },
    );
    cancellingRef.current = settled;
    settled
      .then(() => {
        if (cancellingRef.current === settled) {
          cancellingRef.current = null;
        }
      })
      .catch(() => {
        /* `settled` never rejects. */
      });
    try {
      await pending;
    } catch (err) {
      // The turn was not dropped after all, so the next caller may try again.
      cancelRequestedRef.current = false;
      throw err;
    }
  }, []);

  /** Wait for a cancel already on the wire, so a turn cannot overtake it. */
  const awaitCancel = useCallback(async () => {
    const pending = cancellingRef.current;
    if (pending) {
      await pending;
    }
  }, []);

  /** Forget that these paths were summarised, so the next run asks about them again. */
  const forgetSummarized = useCallback((paths: readonly string[]) => {
    for (const path of paths) {
      summarizedRef.current.delete(path);
    }
  }, []);

  /**
   * Is more prose already on its way? A review dropped for a judge turn is not
   * a failure: newer answers are on the wire and the review will be asked for
   * again, so the page keeps what it has rather than saying it went wrong.
   */
  const summaryRetrying = useCallback(
    (run: SummaryRun, timedOut: boolean) =>
      (run.cancelled && !timedOut) ||
      summaryWantedRef.current ||
      summaryTimerRef.current !== null ||
      queuedRef.current.size > 0,
    [],
  );

  /** What the page shows once a summarize turn has stopped, whatever it wrote. */
  const settleSummary = useCallback(
    (
      run: SummaryRun,
      paths: readonly string[],
      asked: ReadonlySet<string>,
      timedOut: boolean,
    ) => {
      const next = settledText(run);
      if (next) {
        // A file the review said nothing about, or was cut off in, is asked
        // about again next time.
        const written = new Set(
          next.files.filter((f) => !f.incomplete).map((f) => f.path),
        );
        forgetSummarized(paths.filter((path) => !written.has(path)));
        // "from cache": a summarize step that cost nothing made no Luna call —
        // every part of this review was already written down inside the agent.
        const cached = run.steps > 0 && run.costUsd === 0;
        setState((s) => withSettledSummary(s, next, asked, run, cached));
        return;
      }
      // Cancelled, failed or unreadable: forget that these paths were sent, so
      // the next run asks about them again.
      forgetSummarized(paths);
      const error = timedOut ? (run.error ?? SUMMARY_TIMEOUT_ERROR) : run.error;
      setState((s) =>
        withAbandonedSummary(s, run, error, summaryRetrying(run, timedOut)),
      );
    },
    [forgetSummarized, summaryRetrying],
  );

  /**
   * The answers this turn is about, recorded as the ones it was sent, with the
   * cards it covers set to "replacing" while it writes.
   */
  const beginSummary = useCallback((paths: readonly string[]) => {
    const judgments: Record<string, Answers> = {};
    for (const path of paths) {
      const answers = judgmentsRef.current[path]?.answers ?? {};
      judgments[path] = answers;
      summarizedRef.current.set(path, answers);
    }
    setState((s) => ({
      ...s,
      summary: {
        ...s.summary,
        cached: false,
        failed: false,
        replacing: Object.fromEntries(paths.map((p) => [p, true as const])),
        running: true,
        streaming: false,
        writing: null,
      },
    }));
    return judgments;
  }, []);

  /** Hand the session back: whatever the turn did, none of it is still live. */
  const endSummaryTurn = useCallback(
    (abort: AbortController, timer: ReturnType<typeof setTimeout> | null) => {
      if (timer) {
        clearTimeout(timer);
      }
      abort.abort();
      if (summaryAbortRef.current === abort) {
        summaryAbortRef.current = null;
      }
      summaryRunningRef.current = false;
      cancelRequestedRef.current = false;
      inFlightRef.current = false;
    },
    [],
  );

  /**
   * A different review is on screen: this prose describes files that are no
   * longer there, so only the money it cost is still true.
   */
  const dropSummary = useCallback((costUsd: number) => {
    if (costUsd) {
      setState((s) => ({ ...s, spentUsd: s.spentUsd + costUsd }));
    }
    drainRef.current();
  }, []);

  /**
   * One summarize turn, from the first delta to the completed message.
   *
   * The turn's reply *is* the review. The agent runs Luna once per batch of
   * files plus once for the decision and the overall paragraph, all at the
   * same time, and streams the parts back in a fixed order — the overall
   * first — so the growing text is always a well-formed review and the badge
   * and the summary at the top are on screen before the file notes are.
   *
   * Every delta is re-parsed and painted; `message.completed` carries the
   * whole text and is what the review settles on. A section that is no longer
   * the one being written is finished, so its card stops waiting for it even
   * though the turn is still running.
   */
  // Annotated so the two turn kinds can hand the session back to each other.
  const runSummary: (batch: ReviewFile[]) => Promise<void> = useCallback(
    async (batch) => {
      if (budgetSpentRef.current) {
        return;
      }
      inFlightRef.current = true;
      summaryRunningRef.current = true;
      cancelRequestedRef.current = false;
      // Which review this prose is about. If another one opens while Luna
      // writes, everything below is about files nobody can see any more.
      const generation = reviewGenRef.current;
      const paths = batch.map((f) => f.path);
      // A path the reviewer invented is not one of this review's cards.
      const asked = new Set(paths);
      const judgments = beginSummary(paths);

      const abort = new AbortController();
      summaryAbortRef.current = abort;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      /** True once this run is over, so a straggling delta knows it is too late. */
      let finished = false;
      /** Set once a finished `Decision:` line has been seen; before that it is a default. */
      let decisionSeen = false;

      /** Nothing this turn is still writing belongs on screen any more. */
      const stale = () =>
        finished || abort.signal.aborted || generation !== reviewGenRef.current;

      /** Put the text written so far on screen. */
      const paint = (buffer: string) => {
        decisionSeen ||= DECISION_LINE.test(buffer);
        // A refusal arrives on the same stream as a review, and is no review.
        if (stale() || mayBePaused(buffer)) {
          return;
        }
        const parsed = parseSummaryText(buffer, true);
        setState((s) => withStreamedSummary(s, parsed, asked, decisionSeen));
      };

      const run = emptyRun();
      try {
        await awaitCancel();
        const { response, session } = await sendTurn(
          summarizeMessage({ files: batch, judgments, pr: prRef.current }),
        );
        // The turn's own stream takes no abort signal, so a review that has
        // stopped is ended the way an edit ends one: by cancelling the turn.
        timer = setTimeout(() => {
          timedOut = true;
          session.cancel().catch(() => {
            /* The turn will be abandoned below either way. */
          });
        }, SUMMARY_TIMEOUT_MS);
        await readSummaryStream(response, run, {
          isAborted: () => abort.signal.aborted,
          onText: paint,
        });
      } catch {
        /* The session went away, or the stream did: nothing new to show. */
        run.failed = true;
      } finally {
        finished = true;
        endSummaryTurn(abort, timer);
      }

      if (run.parked) {
        budgetSpentRef.current = true;
        queuedRef.current.clear();
        setState((s) => withBudgetSpentSummary(s, run.costUsd));
        return;
      }
      if (generation !== reviewGenRef.current) {
        dropSummary(run.costUsd);
        return;
      }

      const paused = run.cancelled
        ? null
        : pausedIn(run.complete || run.buffer);
      if (paused) {
        // Asked about again once the budget has turned: see `resume`.
        forgetSummarized(paths);
        setState((s) => withPausedSummary(s, run, paused));
      } else {
        settleSummary(run, paths, asked, timedOut);
      }
      // A review that has settled — written, failed or cancelled — is the one
      // that decides the pace: from here on the prose waits for the code to stop
      // moving, whatever this first attempt came back with.
      summarizedOnceRef.current = true;
      drainRef.current();
    },
    [
      awaitCancel,
      beginSummary,
      dropSummary,
      endSummaryTurn,
      forgetSummarized,
      sendTurn,
      settleSummary,
    ],
  );

  /** Start the prose review, if the session is free and anything has moved. */
  const startSummary: () => void = useCallback(() => {
    if (budgetSpentRef.current) {
      return;
    }
    if (inFlightRef.current) {
      summaryWantedRef.current = true;
      return;
    }
    const batch = filesRef.current.filter((file) => {
      const judgment = judgmentsRef.current[file.path];
      if (!judgment || !Object.keys(judgment.answers).length) {
        return false;
      }
      return judgmentMoved(
        summarizedRef.current.get(file.path),
        judgment.answers,
      );
    });
    if (!batch.length) {
      return;
    }
    runSummary(batch.map((f) => ({ ...f }))).catch(() => {
      /* runSummary settles the review itself; there is nothing left to report. */
    });
  }, [runSummary]);

  /**
   * A turn is already running. Keep only the newest content per path for when
   * it settles, and drop the review being written: prose about answers that are
   * on their way to changing is worth nothing, and the session it holds is what
   * the queued turn goes down next.
   */
  const queueBehind = useCallback(
    async (batch: readonly ReviewFile[]) => {
      // Trailing coalescing: only the newest content per path survives the wait.
      for (const file of batch) {
        queuedRef.current.set(file.path, file);
      }
      if (!summaryRunningRef.current) {
        return;
      }
      try {
        // Awaited, because the turn this queues is what goes down that session next.
        await cancelSummary();
      } catch {
        setState((s) => ({
          ...s,
          error: 'could not cancel the previous review',
        }));
      }
    },
    [cancelSummary],
  );

  /**
   * A file that was sent and came back without answers is not judged, and
   * nothing else will ever judge it: its card would pulse "Judging…" for good.
   * Forget what was sent so it is retried once — once only, because a file Jev
   * cannot answer for twice running is not a hiccup. Returns the paths given
   * up on.
   */
  const recordUnjudged = useCallback(
    (
      paths: readonly string[],
      unjudged: readonly string[],
      batch: readonly ReviewFile[],
    ): string[] => {
      const failed: string[] = [];
      for (const path of paths) {
        if (!unjudged.includes(path)) {
          unjudgedRef.current.delete(path);
          continue;
        }
        const tries = (unjudgedRef.current.get(path) ?? 0) + 1;
        unjudgedRef.current.set(path, tries);
        if (tries > 1) {
          failed.push(path);
          continue;
        }
        sentRef.current.delete(path);
        const file = batch.find((f) => f.path === path);
        if (file) {
          queuedRef.current.set(path, file);
        }
      }
      return failed;
    },
    [],
  );

  /** Put one settled judge turn on screen, and queue whatever it did not answer. */
  const applyJudgeResult = useCallback(
    (
      result: TurnResult,
      batch: readonly ReviewFile[],
      paths: readonly string[],
      sent: ReadonlyMap<string, string>,
      ms: number,
      parseReview: TurnRuntime['parseReview'],
    ) => {
      const costUsd = costOf(result.events);
      // The budget prompt: eve parked the turn waiting for an Approve/Stop we
      // will never send. Anything after this could only be parked too.
      if (result.events.some((e) => e.type === 'input.requested')) {
        budgetSpentRef.current = true;
        queuedRef.current.clear();
        setState((s) => withBudgetSpentTurn(s, paths, costUsd));
        return;
      }
      const paused =
        result.status === 'failed' ? null : pausedIn(result.message);
      if (result.status === 'failed' || paused) {
        // Nothing was judged. Forget what was sent so the same files can be
        // retried (for a refusal, by `resume` once the budget has turned, or
        // by the next edit), and count what a failed attempt cost all the same.
        pruneKeys(sentRef.current, (path) => paths.includes(path));
        setState((s) => withUnansweredTurn(s, paths, paused, costUsd));
        return;
      }
      const review = parseReview(result.message);
      const current = new Map(filesRef.current.map((f) => [f.path, f.content]));
      const fresh = freshJudgments(review, sent, current);
      const unjudged = paths.filter(
        (p) => !fresh[p] && current.get(p) === sent.get(p),
      );
      const failed = recordUnjudged(paths, unjudged, batch);
      // "from cache": the whole turn came back from the agent's one-hour cache,
      // which is why it landed in no time and cost nothing.
      const judged = Object.values(fresh);
      const cached =
        judged.length > 0 && judged.every((j) => j.cached === true);
      judgmentsRef.current = { ...judgmentsRef.current, ...fresh };
      setState((s) =>
        withJudgeTurn(s, {
          cached,
          costUsd,
          failed,
          fresh,
          ms,
          paths,
          review,
          unjudged: unjudged.length,
        }),
      );
      // New answers are new material for the review. The first set of a review
      // is summarised straight away; after that the prose waits for the code
      // to settle, because it costs cents and takes seconds.
      if (Object.keys(fresh).length) {
        scheduleSummary(summarizedOnceRef.current ? SUMMARY_DEBOUNCE_MS : 0);
      }
    },
    [recordUnjudged, scheduleSummary],
  );

  /** Drop a summary that has not started yet, so a judge turn can go first. */
  const clearSummaryTimer = useCallback(() => {
    if (!summaryTimerRef.current) {
      return;
    }
    clearTimeout(summaryTimerRef.current);
    summaryTimerRef.current = null;
  }, []);

  /** Mark these files as asked about, and remember the text that went with them. */
  const markSent = useCallback((batch: readonly ReviewFile[]) => {
    for (const file of batch) {
      sentRef.current.set(file.path, file.content);
    }
    setState((s) => ({
      ...s,
      asking: true,
      error: null,
      pending: {
        ...s.pending,
        ...Object.fromEntries(batch.map((f) => [f.path, true as const])),
      },
      stalled: without(
        s.stalled,
        batch.map((f) => f.path),
      ),
    }));
  }, []);

  /** The turn failed on the wire, so say what happened and free what it held. */
  const failTurn = useCallback((err: unknown, paths: readonly string[]) => {
    // A turn can only reach the wire once the runtime is here, so an error
    // from the wire is always checked against the class that threw it.
    const message =
      turnRuntime && err instanceof turnRuntime.ClientError
        ? `HTTP ${err.status}`
        : String(err);
    // The session may be what failed (a retired id throws), so let the next
    // turn open a fresh one. Forgetting what was sent matters too: otherwise
    // the effect below reads those files as already judged.
    sessionRef.current = null;
    for (const path of paths) {
      sentRef.current.delete(path);
    }
    setState((s) => ({
      ...s,
      asking: false,
      error: message,
      pending: without(s.pending, paths),
      stalled: {
        ...s.stalled,
        ...Object.fromEntries(paths.map((p) => [p, true as const])),
      },
    }));
  }, []);

  // Annotated so the function can queue its own follow-up turn below.
  const startTurn: (batch: ReviewFile[]) => Promise<void> = useCallback(
    async (batch) => {
      if (budgetSpentRef.current || !batch.length) {
        return;
      }
      if (inFlightRef.current) {
        await queueBehind(batch);
        return;
      }
      inFlightRef.current = true;
      clearSummaryTimer();
      // A summary that was already due does not stop being due because a judge
      // turn went first — whatever this turn does, it is put back below.
      const summaryWanted = summaryWantedRef.current;
      summaryWantedRef.current = false;
      const paths = batch.map((f) => f.path);
      const sent = new Map(batch.map((f) => [f.path, f.content]));
      markSent(batch);
      const started = performance.now();
      try {
        const message = judgeMessage({ files: batch });
        await awaitCancel();
        const { response } = await sendTurn(message);
        const result = await response.result();
        const ms = Math.round(performance.now() - started);
        const { parseReview } = await loadTurnRuntime();
        applyJudgeResult(result, batch, paths, sent, ms, parseReview);
      } catch (err) {
        failTurn(err, paths);
      } finally {
        // Put back a summary this turn displaced, unless one has just been
        // scheduled — a failed or empty turn must not swallow it.
        summaryWantedRef.current ||=
          summaryWanted && summaryTimerRef.current === null;
        inFlightRef.current = false;
        drainRef.current();
      }
    },
    [
      applyJudgeResult,
      awaitCancel,
      clearSummaryTimer,
      failTurn,
      markSent,
      queueBehind,
      sendTurn,
    ],
  );

  drainRef.current = () => {
    if (inFlightRef.current || budgetSpentRef.current) {
      return;
    }
    const queued = [...queuedRef.current.values()];
    queuedRef.current.clear();
    const live = new Map(filesRef.current.map((f) => [f.path, f.content]));
    const next = queued.filter(
      (f) => live.get(f.path) === f.content && f.content.trim(),
    );
    if (next.length) {
      startTurn(next).catch(() => {
        /* startTurn puts its own failures on screen. */
      });
      return;
    }
    if (!summaryWantedRef.current) {
      return;
    }
    summaryWantedRef.current = false;
    startSummary();
  };

  /**
   * The budget's window has reset: put every file that was refused back in
   * the queue with the code now on screen, ask for the review again if that
   * was refused, and let the ordinary turn machinery send them. A refusal
   * that comes back sets a new reset time, and so a new timer, never a loop.
   */
  const resumeRef = useRef<() => void>(() => {
    /* Replaced below, before any timer can fire. */
  });
  resumeRef.current = () => {
    const s = stateRef.current;
    const live = new Map(filesRef.current.map((f) => [f.path, f]));
    for (const path of Object.keys(s.pausedFiles)) {
      const file = live.get(path);
      sentRef.current.delete(path);
      if (file?.content.trim()) {
        queuedRef.current.set(path, file);
      }
    }
    if (summaryPaused(s)) {
      summaryWantedRef.current = true;
    }
    setState((current) => ({
      ...current,
      paused: null,
      pausedFiles: {},
      summary: summaryPaused(current)
        ? { ...current.summary, error: null, failed: false }
        : current.summary,
    }));
    drainRef.current();
  };

  const resumeAt = state.paused?.resumeAt;
  useEffect(() => {
    if (resumeAt === undefined) {
      return;
    }
    const timer = setTimeout(
      () => resumeRef.current(),
      Math.max(resumeAt - Date.now(), MIN_RESUME_MS),
    );
    return () => clearTimeout(timer);
  }, [resumeAt]);

  // A new review — another example, another paste — is a clean slate: nothing
  // from the last one has a path in this one, and its judgments would linger.
  useEffect(() => {
    // Everything below this line is about the review that just closed, and a
    // summarize turn still on the wire is too: moving this on is what makes it
    // drop its result instead of writing it onto this one.
    reviewGenRef.current = reviewId;
    sentRef.current.clear();
    queuedRef.current.clear();
    unjudgedRef.current.clear();
    judgmentsRef.current = {};
    summarizedRef.current.clear();
    summarizedOnceRef.current = false;
    summaryWantedRef.current = false;
    if (summaryTimerRef.current) {
      clearTimeout(summaryTimerRef.current);
      summaryTimerRef.current = null;
    }
    if (summaryRunningRef.current) {
      // Tell eve to drop the turn, and stop reading it either way. The first
      // turn of this review waits for that cancel rather than racing it.
      cancelSummary().catch(() => {
        setState((s) => ({
          ...s,
          error: 'could not cancel the previous review',
        }));
      });
      summaryAbortRef.current?.abort();
    }
    // The state this review starts from was already reset during the render
    // that opened it; everything here is the bookkeeping that cannot be.
  }, [reviewId, cancelSummary]);

  useEffect(() => {
    filesRef.current = files;
    if (budgetSpentRef.current) {
      return;
    }
    const paths = new Set(files.map((f) => f.path));
    // An emptied file is no longer the file that was judged, and the old
    // answers would describe code nobody can read. Forgetting what was sent
    // for it also means typing the same text back is judged again.
    const emptied = new Set(
      files.filter((f) => !f.content.trim()).map((f) => f.path),
    );
    const stale = (path: string) => !paths.has(path) || emptied.has(path);
    // Drop judgments and queued work for files that are no longer in the review.
    pruneKeys(sentRef.current, stale);
    pruneKeys(queuedRef.current, stale);
    pruneKeys(unjudgedRef.current, stale);
    pruneKeys(summarizedRef.current, stale);
    for (const path of Object.keys(judgmentsRef.current)) {
      if (stale(path)) {
        delete judgmentsRef.current[path];
      }
    }
    setState((s) => withoutStalePaths(s, stale));
    const dirty = unsent(files, sentRef.current);
    if (!dirty.length) {
      return;
    }
    // A queued edit is only worth sending while it is the code on screen; an
    // undo can put a file back to what is already in flight.
    for (const [path, file] of [...queuedRef.current.entries()]) {
      if (files.find((f) => f.path === path)?.content !== file.content) {
        queuedRef.current.delete(path);
      }
    }
    const timer = setTimeout(() => {
      startTurn(dirty).catch(() => {
        /* startTurn puts its own failures on screen. */
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [files, startTurn]);

  // A failed turn forgot what it had sent, so what it held is unsent again,
  // and asking for it now is the same request an edit would have made. A
  // file waiting on the budget waits for its reset, not for this. The failure
  // stays up until the turn actually starts (`markSent` clears it), which may
  // be after an in-flight turn it is queued behind.
  const retry = useCallback((): boolean => {
    const waiting = stateRef.current.pausedFiles;
    const next = unsent(filesRef.current, sentRef.current).filter(
      (f) => waiting[f.path] !== true,
    );
    if (!next.length) {
      return false;
    }
    startTurn(next).catch(() => {
      /* startTurn puts its own failures on screen. */
    });
    return true;
  }, [startTurn]);

  const actions = useMemo<ReviewActions>(() => ({ retry }), [retry]);

  // Nothing should still be listening for prose once the page is gone.
  useEffect(() => {
    return () => {
      if (summaryTimerRef.current) {
        clearTimeout(summaryTimerRef.current);
      }
      summaryAbortRef.current?.abort();
    };
  }, []);

  return { actions, state };
}
