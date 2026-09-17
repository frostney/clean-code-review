"use client";

import { Client, ClientError, type ClientSession } from "eve/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { judgeMessage, summarizeMessage } from "@/agent/lib/prompt";
import { REVIEW_LIMITS, type FileJudgment, type ReviewFile, type ReviewResult } from "@/agent/lib/review";
import type { Answers } from "@/agent/lib/schema";
import { parseReview } from "@/agent/lib/schema";
import { parseSummaryText, REVIEWER_MODEL, type Summary } from "@/agent/lib/summary";
import { isMeaningful, NO_SUMMARY, type SummaryView } from "./display";

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
const SUMMARY_TIMEOUT_ERROR = "the review took too long";

/**
 * The reviewer writes its decision on the first line, so the badge can be on
 * screen long before the prose is. The parser defaults to "comment" when there
 * is no decision yet, which is only worth showing once that line is finished.
 */
const DECISION_LINE = /\bdecision\b\s*[:：][^\n]*\n/i;

/** Tokens and dollars for one settled turn, summed over its model steps. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

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
  usage: TurnUsage | null;
  /** Everything this tab's session has spent so far. */
  spentUsd: number;
  /** The session hit the agent's per-session cost cap and will not answer again. */
  budgetSpent: boolean;
  /** Every file of the last judge turn came back from the agent's one-hour cache. */
  cached: boolean;
  /** Luna's prose review of the whole change and of each file. */
  summary: SummaryView;
}

const IDLE: ReviewState = {
  judgments: {},
  pending: {},
  failed: {},
  asking: false,
  error: null,
  ms: null,
  usage: null,
  spentUsd: 0,
  budgetSpent: false,
  cached: false,
  summary: NO_SUMMARY,
};

/** The pull request a review came from, when it came from one. */
export interface PullRequestContext {
  title: string;
  body?: string;
  url?: string;
}

/** Sum the per-step usage the runtime reports, so the footer can show a real number. */
function usageOf(events: readonly { type: string; data?: unknown }[]): TurnUsage {
  const zero: TurnUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  return events
    .filter((e) => e.type === "step.completed")
    .reduce((acc, e) => {
      const usage = (e.data as { usage?: Partial<TurnUsage> } | undefined)?.usage;
      return {
        inputTokens: acc.inputTokens + (usage?.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (usage?.outputTokens ?? 0),
        costUsd: acc.costUsd + (usage?.costUsd ?? 0),
      };
    }, zero);
}

/**
 * The status line's side of an incomplete answer. A turn that judged every
 * file it was given says nothing; anything less says how much is missing,
 * because silently short answers are how a card gets stuck.
 */
function unjudgedError(review: ReviewResult | null, unjudged: number): string | null {
  if (!review) return "the reply was not a review";
  if (!unjudged) return null;
  return `${unjudged} ${unjudged === 1 ? "file" : "files"} came back unjudged`;
}

function without(map: Record<string, true>, paths: readonly string[]): Record<string, true> {
  const next = { ...map };
  for (const path of paths) delete next[path];
  return next;
}

/**
 * Is this file's judgment different enough to be worth paying for new prose?
 * The same threshold the meters flash on, plus any row that appeared or
 * changed type — a review written about answers that did not move would read
 * the same anyway.
 */
function judgmentMoved(before: Answers | undefined, after: Answers): boolean {
  if (!before) return true;
  for (const [id, answer] of Object.entries(after)) {
    const prev = before[id];
    if (!prev || prev.type !== answer.type) return true;
    if (isMeaningful(prev, answer)) return true;
  }
  return false;
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
): ReviewState {
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
      judgments: {},
      pending: {},
      failed: {},
      ms: null,
      error: null,
      cached: false,
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
   * Bumped whenever a different review opens. A summarize turn captures it on
   * the way out and drops its result if it moved — prose about the previous
   * review's files would otherwise land on this one's.
   */
  const reviewGenRef = useRef(0);
  /** A cancel on the wire, so the next turn queues behind it rather than racing it. */
  const cancellingRef = useRef<Promise<void> | null>(null);
  /** The running summarize turn has already been asked to stop; asking twice is noise. */
  const cancelRequestedRef = useRef(false);
  const prRef = useRef<PullRequestContext | undefined>(pr);
  prRef.current = pr;

  function client(): Client {
    // Same origin: `withEve` mounts the agent at /eve/v1 on this very host.
    clientRef.current ??= new Client({ host: "" });
    return clientRef.current;
  }

  // A durable session outlives the tab that opened it: left alone it sits on
  // the server until sessionTimeoutMs. Retire it on the way out, fire and
  // forget — `keepalive` is what lets the request survive the unload.
  useEffect(() => {
    function onPageHide() {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      void fetch(`/eve/v1/session/${encodeURIComponent(session.state.sessionId)}/reset`, {
        method: "POST",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "tab closed" }),
      }).catch(() => {
        /* The tab is leaving; there is nobody left to tell. */
      });
    }
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  /** What runs next once a turn settles: queued judge work first, then prose. */
  const drainRef = useRef<() => void>(() => {});

  const scheduleSummary = useCallback((delay: number) => {
    if (summaryTimerRef.current) clearTimeout(summaryTimerRef.current);
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
    if (!summaryRunningRef.current || !session) return;
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
      () => {},
      () => {},
    );
    cancellingRef.current = settled;
    void settled.then(() => {
      if (cancellingRef.current === settled) cancellingRef.current = null;
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
    if (pending) await pending;
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
  const runSummary: (batch: ReviewFile[]) => Promise<void> = useCallback(async (batch) => {
    if (budgetSpentRef.current) return;
    inFlightRef.current = true;
    summaryRunningRef.current = true;
    cancelRequestedRef.current = false;
    // Which review this prose is about. If another one opens while Luna
    // writes, everything below is about files nobody can see any more.
    const generation = reviewGenRef.current;
    const paths = batch.map((f) => f.path);
    // A path the reviewer invented is not one of this review's cards.
    const asked = new Set(paths);
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
        running: true,
        streaming: false,
        writing: null,
        failed: false,
        cached: false,
        replacing: Object.fromEntries(paths.map((p) => [p, true as const])),
      },
    }));

    const abort = new AbortController();
    summaryAbortRef.current = abort;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    /** Every delta so far: the text as the page renders it while it arrives. */
    let buffer = "";
    /** The completed message, which is the text the review settles on. */
    let complete = "";
    let steps = 0;
    let costUsd = 0;
    let error: string | null = null;
    /** The turn was dropped — by a judge turn, a new review, or the timeout. */
    let cancelled = false;
    let failed = false;
    /** True once this run is over, so a straggling delta knows it is too late. */
    let finished = false;
    /** Set once a finished `Decision:` line has been seen; before that it is a default. */
    let decisionSeen = false;

    /** Put the text written so far on screen. */
    const paint = (parsed: Summary) => {
      if (finished || abort.signal.aborted || generation !== reviewGenRef.current) return;
      // Only the last section is still being written; the ones before it are
      // done, so their cards stop waiting for a rewrite.
      const done = parsed.files.slice(0, -1).map((f) => f.path).filter((path) => asked.has(path));
      const last = parsed.files.at(-1);
      const writing = last && asked.has(last.path) ? last.path : parsed.overall ? "overall" : null;
      setState((s) => {
        const files = { ...s.summary.files };
        for (const file of parsed.files) if (asked.has(file.path)) files[file.path] = file.summary;
        return {
          ...s,
          summary: {
            ...s.summary,
            overall: parsed.overall || s.summary.overall,
            decision: decisionSeen ? parsed.decision : s.summary.decision,
            files,
            replacing: done.length ? without(s.summary.replacing, done) : s.summary.replacing,
            streaming: true,
            writing,
            model: REVIEWER_MODEL,
            cached: false,
          },
        };
      });
    };

    try {
      await awaitCancel();
      const message = summarizeMessage({ files: batch, judgments, pr: prRef.current });
      if (sessionRef.current) {
        // An expired session reports `no_active_session` rather than throwing,
        // and its id is retired: a send() on it would. Drop it and start over.
        const cleared = await sessionRef.current.clear();
        if (cleared.status === "no_active_session") sessionRef.current = null;
      }
      let response;
      if (sessionRef.current) {
        response = await sessionRef.current.send(message);
      } else {
        const created = await client().sessions.create({ message });
        sessionRef.current = created.session;
        response = created.response;
      }
      const session = sessionRef.current;
      // The turn's own stream takes no abort signal, so a review that has
      // stopped is ended the way an edit ends one: by cancelling the turn.
      timer = setTimeout(() => {
        timedOut = true;
        void session.cancel().catch(() => {
          /* The turn will be abandoned below either way. */
        });
      }, SUMMARY_TIMEOUT_MS);

      for await (const event of response) {
        // A cancel, a new review or an unmount: stop reading, stop painting.
        if (abort.signal.aborted) {
          cancelled = true;
          break;
        }
        if (event.type === "step.completed") {
          steps += 1;
          costUsd += event.data.usage?.costUsd ?? 0;
          continue;
        }
        // The budget prompt: eve parked the turn waiting for an Approve/Stop we
        // will never send. Anything after this could only be parked too.
        if (event.type === "input.requested") {
          budgetSpentRef.current = true;
          queuedRef.current.clear();
          setState((s) => ({
            ...s,
            budgetSpent: true,
            spentUsd: s.spentUsd + costUsd,
            summary: { ...s.summary, running: false, streaming: false, writing: null, replacing: {} },
          }));
          return;
        }
        if (event.type === "message.appended") {
          buffer += event.data.messageDelta;
          if (!decisionSeen && DECISION_LINE.test(buffer)) decisionSeen = true;
          paint(parseSummaryText(buffer, true));
          continue;
        }
        if (event.type === "message.completed") {
          complete = String(event.data.message ?? "");
          continue;
        }
        if (event.type === "turn.cancelled") {
          cancelled = true;
          break;
        }
        if (event.type === "turn.failed" || event.type === "session.failed") {
          failed = true;
          if (event.data.message.trim()) error ??= event.data.message.trim();
          break;
        }
        if (event.type === "session.waiting") break;
      }
    } catch {
      /* The session went away, or the stream did: nothing new to show. */
      failed = true;
    } finally {
      finished = true;
      if (timer) clearTimeout(timer);
      abort.abort();
      if (summaryAbortRef.current === abort) summaryAbortRef.current = null;
      summaryRunningRef.current = false;
      cancelRequestedRef.current = false;
      inFlightRef.current = false;
    }

    // A different review is on screen: this prose describes files that are no
    // longer there, so only the money it cost is still true.
    if (generation !== reviewGenRef.current) {
      if (costUsd) setState((s) => ({ ...s, spentUsd: s.spentUsd + costUsd }));
      drainRef.current();
      return;
    }

    if (timedOut) error ??= SUMMARY_TIMEOUT_ERROR;
    // "from cache": a summarize step that cost nothing made no Luna call —
    // every part of this review was already written down inside the agent.
    const cached = steps > 0 && costUsd === 0;
    // Half a review is not one: a turn that was dropped keeps what is on
    // screen rather than settling on the text it got as far as.
    const next = cancelled || failed ? null : parseSummaryText(complete || buffer);
    if (next && (next.overall || next.files.length)) {
      const written = new Set(next.files.map((f) => f.path));
      // A file the review said nothing about is asked about again next time.
      for (const path of paths) if (!written.has(path)) summarizedRef.current.delete(path);
      setState((s) => ({
        ...s,
        spentUsd: s.spentUsd + costUsd,
        summary: {
          ...s.summary,
          overall: next.overall || s.summary.overall,
          decision: next.overall ? next.decision : s.summary.decision,
          // Files this run did not carry keep the review they already had.
          files: {
            ...s.summary.files,
            ...Object.fromEntries(next.files.filter((f) => asked.has(f.path)).map((f) => [f.path, f.summary])),
          },
          running: false,
          streaming: false,
          writing: null,
          replacing: {},
          settled: true,
          failed: false,
          error: null,
          model: REVIEWER_MODEL,
          cached,
        },
      }));
    } else {
      // Cancelled, failed or unreadable: forget that these paths were sent, so
      // the next run asks about them again.
      for (const path of paths) summarizedRef.current.delete(path);
      // A review dropped for a judge turn is not a failure — newer answers are
      // already on the wire and the review will be asked for again.
      const retrying =
        (cancelled && !timedOut) ||
        summaryWantedRef.current ||
        summaryTimerRef.current !== null ||
        queuedRef.current.size > 0;
      setState((s) => ({
        ...s,
        spentUsd: s.spentUsd + costUsd,
        summary: {
          ...s.summary,
          running: false,
          streaming: false,
          writing: null,
          replacing: {},
          failed: !retrying,
          error: retrying ? null : error,
        },
      }));
    }
    // A review that has settled — written, failed or cancelled — is the one
    // that decides the pace: from here on the prose waits for the code to stop
    // moving, whatever this first attempt came back with.
    summarizedOnceRef.current = true;
    drainRef.current();
  }, [awaitCancel]);

  /** Start the prose review, if the session is free and anything has moved. */
  const startSummary: () => void = useCallback(() => {
    if (budgetSpentRef.current) return;
    if (inFlightRef.current) {
      summaryWantedRef.current = true;
      return;
    }
    const batch = filesRef.current.filter((file) => {
      const judgment = judgmentsRef.current[file.path];
      if (!judgment || !Object.keys(judgment.answers).length) return false;
      return judgmentMoved(summarizedRef.current.get(file.path), judgment.answers);
    });
    if (!batch.length) return;
    void runSummary(batch.map((f) => ({ ...f })));
  }, [runSummary]);

  // Annotated so the function can queue its own follow-up turn below.
  const startTurn: (batch: ReviewFile[]) => Promise<void> = useCallback(async (batch) => {
    if (budgetSpentRef.current || !batch.length) return;
    if (inFlightRef.current) {
      // Trailing coalescing: only the newest content per path survives the wait.
      for (const file of batch) queuedRef.current.set(file.path, file);
      // A review being written about answers that are about to change is worth
      // nothing; drop it and get the session back. Awaited, because the turn
      // this queues is what goes down that session next.
      if (summaryRunningRef.current) {
        try {
          await cancelSummary();
        } catch {
          setState((s) => ({ ...s, error: "could not cancel the previous review" }));
        }
      }
      return;
    }
    inFlightRef.current = true;
    if (summaryTimerRef.current) {
      clearTimeout(summaryTimerRef.current);
      summaryTimerRef.current = null;
    }
    // A summary that was already due does not stop being due because a judge
    // turn went first — whatever this turn does, it is put back below.
    const summaryWanted = summaryWantedRef.current;
    summaryWantedRef.current = false;
    const paths = batch.map((f) => f.path);
    const sent = new Map(batch.map((f) => [f.path, f.content]));
    for (const file of batch) sentRef.current.set(file.path, file.content);
    setState((s) => ({
      ...s,
      asking: true,
      error: null,
      pending: { ...s.pending, ...Object.fromEntries(paths.map((p) => [p, true as const])) },
    }));
    const started = performance.now();
    try {
      const message = judgeMessage({ files: batch });
      await awaitCancel();
      if (sessionRef.current) {
        const cleared = await sessionRef.current.clear();
        // An expired session reports `no_active_session` rather than throwing,
        // and its id is retired: a send() on it would. Drop it and start over.
        if (cleared.status === "no_active_session") sessionRef.current = null;
      }
      let response;
      if (sessionRef.current) {
        response = await sessionRef.current.send(message);
      } else {
        const created = await client().sessions.create({ message });
        sessionRef.current = created.session;
        response = created.response;
      }
      const result = await response.result();
      const ms = Math.round(performance.now() - started);
      const usage = usageOf(result.events);
      // The budget prompt: eve parked the turn waiting for an Approve/Stop we
      // will never send. Anything after this could only be parked too.
      if (result.events.some((e) => e.type === "input.requested")) {
        budgetSpentRef.current = true;
        queuedRef.current.clear();
        setState((s) => ({
          ...s,
          asking: false,
          budgetSpent: true,
          pending: without(s.pending, paths),
          spentUsd: s.spentUsd + usage.costUsd,
        }));
        return;
      }
      if (result.status === "failed") {
        // Forget what was sent so the same files can be retried, and count
        // what the attempt cost all the same.
        for (const path of paths) sentRef.current.delete(path);
        setState((s) => ({
          ...s,
          asking: false,
          error: "the agent could not answer",
          pending: without(s.pending, paths),
          spentUsd: s.spentUsd + usage.costUsd,
        }));
        return;
      }
      const review = parseReview(result.message);
      // A file whose code moved on while this turn ran was judged on text
      // nobody can see any more. The money was spent; the answers are stale,
      // and a newer turn for that path is already queued.
      const current = new Map(filesRef.current.map((f) => [f.path, f.content]));
      const fresh: Record<string, FileJudgment> = {};
      for (const [path, judgment] of Object.entries(review?.files ?? {})) {
        if (current.get(path) !== sent.get(path)) continue;
        if (!Object.keys(judgment.answers).length) continue;
        fresh[path] = judgment;
      }
      // A file that was sent and came back without answers is not judged, and
      // nothing else will ever judge it: its card would pulse "Judging…" for
      // good. Forget what was sent so it is retried once — once only, because
      // a file Jev cannot answer for twice running is not a hiccup.
      const unjudged = paths.filter((p) => !fresh[p] && current.get(p) === sent.get(p));
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
        if (file) queuedRef.current.set(path, file);
      }
      // "from cache": the whole turn came back from the agent's one-hour cache,
      // which is why it landed in no time and cost nothing.
      const judged = Object.values(fresh);
      const cached = judged.length > 0 && judged.every((j) => j.cached === true);
      judgmentsRef.current = { ...judgmentsRef.current, ...fresh };
      setState((s) => ({
        ...s,
        judgments: { ...s.judgments, ...fresh },
        failed: { ...without(s.failed, paths), ...Object.fromEntries(failed.map((p) => [p, true as const])) },
        cached,
        ms,
        asking: false,
        error: unjudgedError(review, unjudged.length),
        usage,
        pending: without(s.pending, paths),
        spentUsd: s.spentUsd + usage.costUsd,
      }));
      // New answers are new material for the review. The first set of a review
      // is summarised straight away; after that the prose waits for the code
      // to settle, because it costs cents and takes seconds.
      if (Object.keys(fresh).length) scheduleSummary(summarizedOnceRef.current ? SUMMARY_DEBOUNCE_MS : 0);
    } catch (err) {
      const message = err instanceof ClientError ? `HTTP ${err.status}` : String(err);
      // The session may be what failed (a retired id throws), so let the next
      // turn open a fresh one. Forgetting what was sent matters too: otherwise
      // the effect below reads those files as already judged.
      sessionRef.current = null;
      for (const path of paths) sentRef.current.delete(path);
      setState((s) => ({ ...s, asking: false, error: message, pending: without(s.pending, paths) }));
    } finally {
      // Put back a summary this turn displaced, unless one has just been
      // scheduled — a failed or empty turn must not swallow it.
      if (summaryWanted && !summaryTimerRef.current) summaryWantedRef.current = true;
      inFlightRef.current = false;
      drainRef.current();
    }
  }, [awaitCancel, cancelSummary, scheduleSummary]);

  drainRef.current = () => {
    if (inFlightRef.current || budgetSpentRef.current) return;
    const queued = [...queuedRef.current.values()];
    queuedRef.current.clear();
    const live = new Map(filesRef.current.map((f) => [f.path, f.content]));
    const next = queued.filter((f) => live.get(f.path) === f.content && f.content.trim());
    if (next.length) {
      void startTurn(next);
      return;
    }
    if (!summaryWantedRef.current) return;
    summaryWantedRef.current = false;
    startSummary();
  };

  // A new review — another example, another paste — is a clean slate: nothing
  // from the last one has a path in this one, and its judgments would linger.
  useEffect(() => {
    // Everything below this line is about the review that just closed, and a
    // summarize turn still on the wire is too: the bump is what makes it drop
    // its result instead of writing it onto this one.
    reviewGenRef.current += 1;
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
      void cancelSummary().catch(() => {
        setState((s) => ({ ...s, error: "could not cancel the previous review" }));
      });
      summaryAbortRef.current?.abort();
    }
    // The state this review starts from was already reset during the render
    // that opened it; everything here is the bookkeeping that cannot be.
  }, [reviewId, cancelSummary]);

  useEffect(() => {
    filesRef.current = files;
    if (budgetSpentRef.current) return;
    const paths = new Set(files.map((f) => f.path));
    // An emptied file is no longer the file that was judged, and the old
    // answers would describe code nobody can read. Forgetting what was sent
    // for it also means typing the same text back is judged again.
    const emptied = new Set(files.filter((f) => !f.content.trim()).map((f) => f.path));
    const stale = (path: string) => !paths.has(path) || emptied.has(path);
    // Drop judgments and queued work for files that are no longer in the review.
    for (const path of [...sentRef.current.keys()]) if (stale(path)) sentRef.current.delete(path);
    for (const path of [...queuedRef.current.keys()]) if (stale(path)) queuedRef.current.delete(path);
    for (const path of [...unjudgedRef.current.keys()]) if (stale(path)) unjudgedRef.current.delete(path);
    for (const path of [...summarizedRef.current.keys()]) if (stale(path)) summarizedRef.current.delete(path);
    for (const path of Object.keys(judgmentsRef.current)) if (stale(path)) delete judgmentsRef.current[path];
    setState((s) => {
      const gone = Object.keys(s.judgments).filter(stale);
      const orphaned = Object.keys(s.pending).filter(stale);
      const cleared = Object.keys(s.failed).filter(stale);
      const notes = Object.keys(s.summary.files).filter(stale);
      if (!gone.length && !orphaned.length && !cleared.length && !notes.length) return s;
      const judgments = { ...s.judgments };
      for (const path of gone) delete judgments[path];
      const summaryFiles = { ...s.summary.files };
      for (const path of notes) delete summaryFiles[path];
      return {
        ...s,
        judgments,
        pending: without(s.pending, orphaned),
        failed: without(s.failed, cleared),
        summary: { ...s.summary, files: summaryFiles },
      };
    });
    // An empty file is not a question; Jev is never asked about one.
    const dirty = files
      .filter((f) => f.content.trim() && sentRef.current.get(f.path) !== f.content)
      .slice(0, REVIEW_LIMITS.maxFiles);
    if (!dirty.length) return;
    // A queued edit is only worth sending while it is the code on screen; an
    // undo can put a file back to what is already in flight.
    for (const [path, file] of [...queuedRef.current.entries()]) {
      if (files.find((f) => f.path === path)?.content !== file.content) queuedRef.current.delete(path);
    }
    const timer = setTimeout(() => void startTurn(dirty), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [files, startTurn]);

  // Nothing should still be listening for prose once the page is gone.
  useEffect(() => {
    return () => {
      if (summaryTimerRef.current) clearTimeout(summaryTimerRef.current);
      summaryAbortRef.current?.abort();
    };
  }, []);

  return state;
}
