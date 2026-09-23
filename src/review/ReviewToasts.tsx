'use client';

import { useState } from 'react';

import { isProsePath, type ReviewFile } from '@/agent/lib/review/review';
import { describePullRequestError } from '@/src/pull-request/errors';
import { type ToastItem, ToastRegion } from '@/src/ui/Toast';

import { partialCoverage } from './display';
import { describeTurnError } from './errors';
import { useReviewControls, useReviewView } from './ReviewProvider';
import type { ReviewState } from './useReview';

/** The row for that file in the file list, which stays put while cards come and go. */
function railRow(path?: string): string {
  return path === undefined
    ? '[data-rail] button[data-file]'
    : `[data-rail] button[data-file="${path.replace(/["\\]/g, '\\$&')}"]`;
}

/**
 * A repeat failure usually has the same message, so the count (bumped each
 * time the value arrives from null) is what makes the live region speak again
 * and a dismissed toast return.
 */
function useRaised(value: string | null): {
  count: number;
  last: string | null;
} {
  const [seen, setSeen] = useState({
    count: value ? 1 : 0,
    last: value,
    value,
  });

  if (seen.value === value) {
    return seen;
  }
  const next = {
    count: value ? seen.count + 1 : seen.count,
    last: value ?? seen.last,
    value,
  };

  setSeen(next);

  return next;
}

function usePullRequestToast(): ToastItem | null {
  const { prError, retryingPr } = useReviewView();
  const { dismissPrError, retryPullRequest } = useReviewControls();
  // During a retry the old error stays up, busy; it is raised again when the
  // answer lands.
  const raised = useRaised(prError && !retryingPr ? prError : null);

  if (!prError) {
    return null;
  }
  const trouble = describePullRequestError(prError);

  return {
    action: trouble.retry
      ? {
          busy: retryingPr,
          busyLabel: 'Retrying…',
          label: 'Retry',
          run: retryPullRequest,
        }
      : undefined,
    id: 'pr',
    message: trouble.sentence,
    onDismiss: dismissPrError,
    raised: raised.count,
    tone: 'error',
  };
}

type RetryPhase = 'waiting' | 'running' | null;

/**
 * `waiting` until the turn starts (it may queue behind another), `running`
 * until it settles, and back to null if the queued turn is dropped: its files
 * were emptied, removed or paused, the budget ran out, or the failure was
 * cleared without a turn.
 */
function nextPhase(
  phase: RetryPhase,
  judge: { asking: boolean; budgetSpent: boolean; error: string | null },
  retryable: boolean,
): RetryPhase {
  if (phase === 'waiting') {
    if (judge.asking) {
      return 'running';
    }
    const dropped = !retryable || judge.budgetSpent || judge.error === null;

    return dropped ? null : 'waiting';
  }

  return phase === 'running' && !judge.asking ? null : phase;
}

function useJudgeToast(retryable: boolean): ToastItem | null {
  const { reviewState } = useReviewView();
  const { retryJudging } = useReviewControls();
  const raised = useRaised(reviewState.error);

  // The toast stays up, busy, from the press until the retried turn settles,
  // so the button under the reader's finger never disappears.
  const [retry, setRetry] = useState<RetryPhase>(null);
  const phase = nextPhase(retry, reviewState, retryable);

  if (phase !== retry) {
    setRetry(phase);
  }
  // Dismisses this raising only; the next failure shows again.
  const [dismissed, setDismissed] = useState(0);
  // A retry that fails at once can clear and restore the error within one
  // render, unseen by `useRaised`, so presses count too.
  const [presses, setPresses] = useState(0);

  const error = reviewState.error ?? (phase ? raised.last : null);

  if (!error || (phase === null && raised.count === dismissed)) {
    return null;
  }
  const trouble = describeTurnError(error);

  // The budget-spent notice supersedes a retryable failure.
  if (trouble.retry && reviewState.budgetSpent) {
    return null;
  }
  const canRetry = trouble.retry && (retryable || phase !== null);

  return {
    action: canRetry
      ? {
          busy: phase !== null,
          busyLabel: 'Retrying…',
          label: 'Retry',
          run: () => {
            if (retryJudging()) {
              setRetry('waiting');
              setPresses((n) => n + 1);
            }
          },
        }
      : undefined,
    handOnTo: railRow(),
    id: 'judge',
    message: trouble.sentence,
    onDismiss: () => {
      setRetry(null);
      setDismissed(raised.count);
    },
    raised: `${raised.count}.${presses}`,
    tone: trouble.tone,
  };
}

interface Gaps {
  /** Given up on after two turns without an answer. */
  unjudged: string[];
  partial: string[];
}

/** Files on screen whose last answer is missing or partial, and not being asked about. */
function judgingGaps(files: readonly ReviewFile[], s: ReviewState): Gaps {
  const gaps: Gaps = { partial: [], unjudged: [] };

  for (const { path, content } of files) {
    if (
      isProsePath(path) ||
      !content.trim() ||
      s.pending[path] === true ||
      s.pausedFiles[path] === true
    ) {
      continue;
    }
    const judgment = s.judgments[path];

    if (s.givenUp[path] === true && !judgment) {
      gaps.unjudged.push(path);
    } else if (partialCoverage(judgment)) {
      gaps.partial.push(path);
    }
  }

  return gaps;
}

function filesText(n: number): string {
  return n === 1 ? 'one file' : `${n} files`;
}

function gapsSentence({ unjudged, partial }: Gaps): string {
  const none = `Jev sent no answer for ${filesText(unjudged.length)}`;

  if (!partial.length) {
    return `${none}.`;
  }
  const some = partial.length === 1 ? 'one' : String(partial.length);

  return unjudged.length
    ? `${none} and judged ${some} more only in part.`
    : `Jev judged ${filesText(partial.length)} only in part; ${partial.length === 1 ? 'its card says' : 'their cards say'} what the verdict covers.`;
}

interface Rejudging {
  paths: string[];
  message: string;
  /** A turn has taken the files; until then it may be queued behind another. */
  started: boolean;
}

/** `null` once the turn has settled, or when the queued turn is dropped. */
function nextRejudging(
  current: Rejudging | null,
  s: ReviewState,
  onScreen: ReadonlySet<string>,
): Rejudging | null {
  if (!current) {
    return null;
  }
  const running = current.paths.some((path) => s.pending[path] === true);

  if (current.started) {
    return running ? current : null;
  }
  if (running) {
    return { ...current, started: true };
  }
  const dropped =
    s.budgetSpent ||
    s.paused !== null ||
    !current.paths.some((path) => onScreen.has(path));

  return dropped ? null : current;
}

/**
 * Stays up, busy, from the press until the files' turn settles, then either
 * names what is still missing, with Retry under the same finger, or goes and
 * hands the focus to the file list.
 */
function useCoverageToast(): ToastItem | null {
  const { review, reviewState } = useReviewView();
  const { rejudge } = useReviewControls();
  const gaps = judgingGaps(review.files, reviewState);
  const paths = [...gaps.unjudged, ...gaps.partial];
  const key = paths.join('\n');
  const [rejudging, setRejudging] = useState<Rejudging | null>(null);
  const phase = nextRejudging(
    rejudging,
    reviewState,
    new Set(review.files.map((f) => f.path)),
  );

  if (phase !== rejudging) {
    setRejudging(phase);
  }
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (!phase && (!paths.length || dismissed === key)) {
    return null;
  }
  const message = phase ? phase.message : gapsSentence(gaps);

  return {
    action: {
      busy: phase !== null,
      busyLabel: 'Retrying…',
      label: 'Retry',
      run: () => {
        if (rejudge(paths)) {
          setRejudging({ message, paths, started: false });
        }
      },
    },
    handOnTo: railRow(phase?.paths[0] ?? paths[0]),
    id: 'coverage',
    message,
    onDismiss: () => {
      setRejudging(null);
      setDismissed(key);
    },
    raised: key,
    tone: 'warn',
  };
}

/**
 * One toast per kind, keyed by kind, so a retry failing with a different
 * reason updates in place and keeps focus on its button. The landing view
 * shows failures through the duck instead.
 */
export function ReviewToasts({ retryable }: { retryable: boolean }) {
  const pr = usePullRequestToast();
  const judged = useJudgeToast(retryable);
  const coverage = useCoverageToast();
  const toasts = [pr, judged, coverage].filter(
    (t): t is ToastItem => t !== null,
  );

  return <ToastRegion toasts={toasts} />;
}
