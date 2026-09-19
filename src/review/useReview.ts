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

/** Set once loaded, for `failTurn`'s synchronous `instanceof` check. */
let turnRuntime: TurnRuntime | null = null;
let turnRuntimeLoading: Promise<TurnRuntime> | null = null;

/**
 * Lazy, so a page that never sends a turn never downloads eve's client. A
 * failed chunk load is not cached; the next turn tries again.
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

/** Coalesces a burst of keystrokes; about the pause a typist makes. */
const DEBOUNCE_MS = 300;

/**
 * After the first review, prose waits this long after the last judgment:
 * it costs cents and takes seconds, so it waits for the code to stop moving.
 */
const SUMMARY_DEBOUNCE_MS = 2_000;

/**
 * A summarize turn is a few parallel Luna calls taking seconds, so this
 * catches a stopped turn rather than bounding a slow one.
 */
const SUMMARY_TIMEOUT_MS = 60_000;

const SUMMARY_TIMEOUT_ERROR = 'the review took too long';

/**
 * The parser defaults the decision to "comment" until it has one, so the
 * streamed decision is only trusted once its line is finished.
 */
const DECISION_LINE = /\bdecision\b\s*[:：][^\n]*\n/i;

export interface ReviewState {
  /** Kept while the next turn runs. */
  judgments: Record<string, FileJudgment>;
  /** Paths with a request in flight or queued behind one. */
  pending: Record<string, true>;
  /** Paths that came back unjudged twice and will not be asked about again. */
  failed: Record<string, true>;
  asking: boolean;
  error: string | null;
  /** Duration of the last settled turn. */
  ms: number | null;
  /** Per tab session; survives opening another review. */
  spentUsd: number;
  /** The session hit the agent's per-session cost cap; permanent for the tab. */
  budgetSpent: boolean;
  /**
   * The site's hourly or daily model budget refused a turn. Set while any file
   * or the review still waits on it; unlike `budgetSpent` it clears itself:
   * the page asks again after the window resets.
   */
  paused: LocalPause | null;
  pausedFiles: Record<string, true>;
  /**
   * Paths a failed turn let go: nothing asks about them again until Retry or
   * an edit. Separate from `error`, which can be dismissed without these
   * starting to wait.
   */
  stalled: Record<string, true>;
  /** Every file of the last judge turn came from the agent's one-hour cache. */
  cached: boolean;
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

export interface LocalPause extends PausedReply {
  /** In this tab's `Date.now()` terms, jitter included. */
  resumeAt: number;
}

/**
 * Every paused tab is told the same reset; without a spread they would all ask
 * at once, the burst the spend brake counts worst.
 */
const RESUME_JITTER_MS = 60_000;

// Uses the server's relative wait, not its reset time, so a browser clock
// running ahead cannot read a future reset as already past.
function localPause(reply: PausedReply): LocalPause {
  return {
    ...reply,
    resumeAt:
      Date.now() + reply.waitMs + Math.floor(Math.random() * RESUME_JITTER_MS),
  };
}

function pausedIn(text: string | null | undefined): LocalPause | null {
  const reply = parsePaused(text);
  return reply ? localPause(reply) : null;
}

/** A refusal with no wait, right on a window's edge, must not become a turn per tick. */
const MIN_RESUME_MS = 1000;

const PAUSED_SUMMARY_ERROR = 'the review budget is spent';

const summaryPaused = (s: ReviewState) =>
  s.summary.error === PAUSED_SUMMARY_ERROR;

// A turn that got through clears only what it carried, so the notice stays
// until nothing waits on the budget.
function withPauseReconciled(s: ReviewState): ReviewState {
  return s.paused && !Object.keys(s.pausedFiles).length && !summaryPaused(s)
    ? { ...s, paused: null }
    : s;
}

export interface PullRequestContext {
  title: string;
  body?: string;
  url?: string;
}

function costOf(events: readonly { type: string; data?: unknown }[]): number {
  return events
    .filter((e) => e.type === 'step.completed')
    .reduce((total, e) => {
      const usage = (e.data as { usage?: { costUsd?: number } } | undefined)
        ?.usage;
      return total + (usage?.costUsd ?? 0);
    }, 0);
}

// Silently short answers are how a card gets stuck, so say how many are missing.
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
 * Whether new prose is worth paying for: the meters' flash threshold, plus any
 * row that appeared or changed type.
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

type TurnResult = Awaited<ReturnType<MessageResponse['result']>>;

interface SummaryRun {
  /** Deltas so far; rendered while streaming. */
  buffer: string;
  /** By a judge turn, a new review, or the timeout. */
  cancelled: boolean;
  /** `message.completed`'s text; preferred over `buffer` when settling. */
  complete: string;
  costUsd: number;
  error: string | null;
  failed: boolean;
  /** Parked on eve's budget prompt; nothing more will arrive. */
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

/** Returns true when the stream is over for this turn. */
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
    // eve's cost-cap prompt waits for an Approve/Stop the page never sends.
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

/** Fills `run` in place, so a stream that throws midway still records its cost and text. */
async function readSummaryStream(
  response: MessageResponse,
  run: SummaryRun,
  hooks: { isAborted: () => boolean; onText: (buffer: string) => void },
): Promise<void> {
  for await (const event of response) {
    if (hooks.isAborted()) {
      run.cancelled = true;
      break;
    }
    if (applySummaryEvent(run, event, hooks.onText)) {
      break;
    }
  }
}

/** A cancelled turn keeps what is on screen rather than settling on half a review. */
function settledText(run: SummaryRun): Summary | null {
  if (run.cancelled || run.failed) {
    return null;
  }
  const next = parseSummaryText(run.complete || run.buffer);
  return next.overall || next.files.length ? next : null;
}

/** Not always the last file section: a part written again repeats its sections from the first. */
function writingSection(
  parsed: Summary,
  asked: ReadonlySet<string>,
): string | null {
  if (parsed.writing !== null && asked.has(parsed.writing)) {
    return parsed.writing;
  }
  return parsed.overall ? OVERALL_BLOCK : null;
}

function withStreamedSummary(
  s: ReviewState,
  parsed: Summary,
  asked: ReadonlySet<string>,
  decisionSeen: boolean,
): ReviewState {
  const files = { ...s.summary.files };
  // A rewritten block replaces any earlier run's cut-off mark.
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
  // Sections before the open one are done. Those after it are a previous try
  // of a part now being rewritten, about to be replaced.
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

/** Key for the overall block in `SummaryView['incomplete']` and `writing`. */
const OVERALL_BLOCK = 'overall';

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

/** Drops judgments of files whose text changed while the turn ran. */
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

interface JudgeTurn {
  cached: boolean;
  costUsd: number;
  /** Unanswered twice running; given up on. */
  failed: readonly string[];
  fresh: Record<string, FileJudgment>;
  ms: number;
  paths: readonly string[];
  review: ReviewResult | null;
  unjudged: number;
}

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

function withoutStalePaths(
  s: ReviewState,
  stale: (path: string) => boolean,
): ReviewState {
  const gone = Object.keys(s.judgments).filter(stale);
  const orphaned = Object.keys(s.pending).filter(stale);
  const cleared = Object.keys(s.failed).filter(stale);
  const notes = Object.keys(s.summary.files).filter(stale);
  const waiting = Object.keys(s.pausedFiles).filter(stale);
  const letGo = Object.keys(s.stalled).filter(stale);
  if (
    [gone, orphaned, cleared, notes, waiting, letGo].every((l) => !l.length)
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
    stalled: without(s.stalled, letGo),
    summary: {
      ...s.summary,
      files: summaryFiles,
      incomplete: without(s.summary.incomplete, notes),
    },
  });
}

/** Changed code files. Empty files and prose (e.g. a README) are never judged. */
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

export interface ReviewActions {
  /** Re-asks every unanswered file; false when there was nothing to ask. */
  retry: () => boolean;
}

/**
 * One durable eve session per tab, one turn in flight. An edit sends only the
 * edited file and its judgment is merged by path, so unchanged cards keep
 * their answers and their meters do not flash.
 *
 * Each turn clears the session history first, so the model cannot anchor on
 * code no longer on screen.
 *
 * Judge turns (Jev) and summarize turns (Luna's streamed review) share the
 * session. A judge turn cancels a running summary, whose answers it is about
 * to change.
 *
 * At the per-session cost cap eve asks for approval (`input.requested`). A
 * demo has nobody to ask, so the hook stops and the last judgments stay.
 */
export function useReview(
  reviewId: string,
  files: readonly ReviewFile[],
  pr?: PullRequestContext,
): { state: ReviewState; actions: ReviewActions } {
  const [state, setState] = useState<ReviewState>(IDLE);

  /**
   * Reset during render, not in an effect: an effect is a frame late, and the
   * new cards would flash "No review yet" against the old settled summary.
   * `spentUsd` and `budgetSpent` survive; the budget is the tab's.
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
      // A budget pause belonged to the last review; this one's first turn
      // finds out afresh, and a fully cached review is still served.
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
  /** Path → content last sent. */
  const sentRef = useRef(new Map<string, string>());
  /** Changed while a turn ran; newest content per path. */
  const queuedRef = useRef(new Map<string, ReviewFile>());
  /** Path → consecutive turns with no judgment for it. */
  const unjudgedRef = useRef(new Map<string, number>());
  const filesRef = useRef<readonly ReviewFile[]>(files);
  const budgetSpentRef = useRef(false);

  const judgmentsRef = useRef<Record<string, FileJudgment>>({});
  /** Path → answers the last summarize turn was sent. */
  const summarizedRef = useRef(new Map<string, Answers>());
  const summaryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The turn's stream takes no signal; this stops the page painting it. */
  const summaryAbortRef = useRef<AbortController | null>(null);
  const summaryRunningRef = useRef(false);
  /** Due but the session is busy; started when it frees. */
  const summaryWantedRef = useRef(false);
  /** Until set, a summary runs without `SUMMARY_DEBOUNCE_MS`. */
  const summarizedOnceRef = useRef(false);
  /**
   * A summarize turn captures this when it starts and drops its result if it
   * changed, or the previous review's prose would land on this one.
   */
  const reviewGenRef = useRef(reviewId);
  /** The next turn awaits this rather than racing the cancel. */
  const cancellingRef = useRef<Promise<void> | null>(null);
  const cancelRequestedRef = useRef(false);
  const prRef = useRef<PullRequestContext | undefined>(pr);
  prRef.current = pr;
  /** For the resume timer, which runs outside any render. */
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

  const sendTurn = useCallback(
    async (message: string) => {
      if (sessionRef.current) {
        // An expired session reports `no_active_session` here rather than
        // throwing, but send() on its retired id would throw.
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

  // A durable session would otherwise sit on the server until
  // sessionTimeoutMs. `keepalive` lets the request survive the unload.
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

  /** Queued judge work first, then prose. */
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
   * Throws if the cancel request failed: the caller is about to send into a
   * session that is still busy. Parked in `cancellingRef` until settled so eve
   * hears the cancel before the next turn.
   */
  const cancelSummary = useCallback(async () => {
    const session = sessionRef.current;
    if (!summaryRunningRef.current || !session) {
      return;
    }
    // Opening a review and the next judge turn often both cancel at once; the
    // second caller waits on the first request.
    if (cancelRequestedRef.current) {
      await cancellingRef.current;
      return;
    }
    cancelRequestedRef.current = true;
    const pending = session.cancel();
    summaryAbortRef.current?.abort();
    const settled: Promise<void> = pending.then(
      () => {
        /* Resolved. */
      },
      () => {
        /* Rethrown to this caller below. */
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

  const awaitCancel = useCallback(async () => {
    const pending = cancellingRef.current;
    if (pending) {
      await pending;
    }
  }, []);

  const forgetSummarized = useCallback((paths: readonly string[]) => {
    for (const path of paths) {
      summarizedRef.current.delete(path);
    }
  }, []);

  /**
   * A review dropped because newer answers are coming is not shown as a
   * failure; the page keeps what it has.
   */
  const summaryRetrying = useCallback(
    (run: SummaryRun, timedOut: boolean) =>
      (run.cancelled && !timedOut) ||
      summaryWantedRef.current ||
      summaryTimerRef.current !== null ||
      queuedRef.current.size > 0,
    [],
  );

  const settleSummary = useCallback(
    (
      run: SummaryRun,
      paths: readonly string[],
      asked: ReadonlySet<string>,
      timedOut: boolean,
    ) => {
      const next = settledText(run);
      if (next) {
        const written = new Set(
          next.files.filter((f) => !f.incomplete).map((f) => f.path),
        );
        forgetSummarized(paths.filter((path) => !written.has(path)));
        // A step that cost nothing made no Luna call: served from the agent's cache.
        const cached = run.steps > 0 && run.costUsd === 0;
        setState((s) => withSettledSummary(s, next, asked, run, cached));
        return;
      }
      forgetSummarized(paths);
      const error = timedOut ? (run.error ?? SUMMARY_TIMEOUT_ERROR) : run.error;
      setState((s) =>
        withAbandonedSummary(s, run, error, summaryRetrying(run, timedOut)),
      );
    },
    [forgetSummarized, summaryRetrying],
  );

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

  /** Another review is on screen: keep only the cost. */
  const dropSummary = useCallback((costUsd: number) => {
    if (costUsd) {
      setState((s) => ({ ...s, spentUsd: s.spentUsd + costUsd }));
    }
    drainRef.current();
  }, []);

  /**
   * The agent runs Luna in parallel per batch of files plus once for the
   * overall, and streams the parts in a fixed order (overall first), so the
   * growing text always parses as a review. Every delta is re-parsed and
   * painted.
   */
  const runSummary: (batch: ReviewFile[]) => Promise<void> = useCallback(
    async (batch) => {
      if (budgetSpentRef.current) {
        return;
      }
      inFlightRef.current = true;
      summaryRunningRef.current = true;
      cancelRequestedRef.current = false;
      const generation = reviewGenRef.current;
      const paths = batch.map((f) => f.path);
      // Ignores paths the reviewer invented.
      const asked = new Set(paths);
      const judgments = beginSummary(paths);

      const abort = new AbortController();
      summaryAbortRef.current = abort;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      /** So a straggling delta knows it is too late. */
      let finished = false;
      let decisionSeen = false;

      const stale = () =>
        finished || abort.signal.aborted || generation !== reviewGenRef.current;

      const paint = (buffer: string) => {
        decisionSeen ||= DECISION_LINE.test(buffer);
        // A budget refusal arrives on the same stream as a review.
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
        // The stream takes no abort signal, so time out by cancelling the turn.
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
        // Asked again after the reset: see `resumeRef`.
        forgetSummarized(paths);
        setState((s) => withPausedSummary(s, run, paused));
      } else {
        settleSummary(run, paths, asked, timedOut);
      }
      // Debounce from now on, whatever this attempt came back with.
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
      /* runSummary puts its own failures on screen. */
    });
  }, [runSummary]);

  /** Also cancels a running summary: its answers are about to change. */
  const queueBehind = useCallback(
    async (batch: readonly ReviewFile[]) => {
      for (const file of batch) {
        queuedRef.current.set(file.path, file);
      }
      if (!summaryRunningRef.current) {
        return;
      }
      try {
        // Awaited: the queued turn goes down this session next.
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
   * Nothing else would re-ask about an unanswered file, so its card would pulse
   * "Judging…" forever. Retried once; twice running is not a hiccup, and it is
   * returned as given up on.
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
      // eve's cost-cap prompt waits for an Approve/Stop the page never sends.
      if (result.events.some((e) => e.type === 'input.requested')) {
        budgetSpentRef.current = true;
        queuedRef.current.clear();
        setState((s) => withBudgetSpentTurn(s, paths, costUsd));
        return;
      }
      const paused =
        result.status === 'failed' ? null : pausedIn(result.message);
      if (result.status === 'failed' || paused) {
        // Forget what was sent so the files can be retried (a refusal by
        // `resumeRef`, a failure by Retry or an edit).
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
      if (Object.keys(fresh).length) {
        scheduleSummary(summarizedOnceRef.current ? SUMMARY_DEBOUNCE_MS : 0);
      }
    },
    [recordUnjudged, scheduleSummary],
  );

  const clearSummaryTimer = useCallback(() => {
    if (!summaryTimerRef.current) {
      return;
    }
    clearTimeout(summaryTimerRef.current);
    summaryTimerRef.current = null;
  }, []);

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

  const failTurn = useCallback((err: unknown, paths: readonly string[]) => {
    const message =
      turnRuntime && err instanceof turnRuntime.ClientError
        ? `HTTP ${err.status}`
        : String(err);
    // The session may be what failed (a retired id throws), so open a fresh
    // one. Unless sent is forgotten, `unsent` reads these files as judged.
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
        // Restore a summary this turn displaced unless one was just scheduled;
        // a failed or empty turn must not swallow it.
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
   * Requeues refused files with their current code. A repeat refusal sets a
   * new reset time and so a new timer, never a loop.
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

  // State was reset during render (see `shownReviewId`); this is the ref
  // bookkeeping that cannot be.
  useEffect(() => {
    // Makes a summarize turn still on the wire drop its result.
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
      // The first turn of this review awaits the cancel rather than racing it.
      cancelSummary().catch(() => {
        setState((s) => ({
          ...s,
          error: 'could not cancel the previous review',
        }));
      });
      summaryAbortRef.current?.abort();
    }
  }, [reviewId, cancelSummary]);

  useEffect(() => {
    filesRef.current = files;
    if (budgetSpentRef.current) {
      return;
    }
    const paths = new Set(files.map((f) => f.path));
    // Emptied files lose their judgment; forgetting what was sent means typing
    // the same text back is judged again.
    const emptied = new Set(
      files.filter((f) => !f.content.trim()).map((f) => f.path),
    );
    const stale = (path: string) => !paths.has(path) || emptied.has(path);
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
    // An undo can put a file back to what is already in flight.
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

  // A failed turn forgot what it sent, so its files are unsent again. Files
  // waiting on the budget wait for the reset. The failure stays shown until
  // the turn starts (`markSent` clears it), possibly behind an in-flight one.
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
