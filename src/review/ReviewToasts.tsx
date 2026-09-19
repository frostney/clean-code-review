'use client';

import { useState } from 'react';

import { describePullRequestError } from '@/src/pull-request/errors';
import { type ToastItem, ToastRegion } from '@/src/ui/Toast';

import { describeTurnError } from './errors';
import { useReviewControls, useReviewView } from './ReviewProvider';

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
  const { judge } = useReviewView();
  const { retryJudging } = useReviewControls();
  const raised = useRaised(judge.error);

  // The toast stays up, busy, from the press until the retried turn settles,
  // so the button under the reader's finger never disappears.
  const [retry, setRetry] = useState<RetryPhase>(null);
  const phase = nextPhase(retry, judge, retryable);
  if (phase !== retry) {
    setRetry(phase);
  }
  // Dismisses this raising only; the next failure shows again.
  const [dismissed, setDismissed] = useState(0);
  // A retry that fails at once can clear and restore the error within one
  // render, unseen by `useRaised`, so presses count too.
  const [presses, setPresses] = useState(0);

  const error = judge.error ?? (phase ? raised.last : null);
  if (!error || (phase === null && raised.count === dismissed)) {
    return null;
  }
  const trouble = describeTurnError(error);
  // The budget-spent notice supersedes a retryable failure.
  if (trouble.retry && judge.budgetSpent) {
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

/**
 * One toast per kind, keyed by kind, so a retry failing with a different
 * reason updates in place and keeps focus on its button. The landing view
 * shows failures through the duck instead.
 */
export function ReviewToasts({ retryable }: { retryable: boolean }) {
  const pr = usePullRequestToast();
  const judged = useJudgeToast(retryable);
  const toasts = [pr, judged].filter((t): t is ToastItem => t !== null);
  return <ToastRegion toasts={toasts} />;
}
