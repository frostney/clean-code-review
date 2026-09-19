'use client';

import { useState } from 'react';

import { describePullRequestError } from '@/src/pull-request/errors';
import { type ToastItem, ToastRegion } from '@/src/ui/Toast';

import { describeTurnError } from './errors';
import { useReviewControls, useReviewView } from './ReviewProvider';

/**
 * How many times a failure has been raised, and the last thing it said.
 *
 * A retry that fails again usually fails with the same words, so the message
 * alone cannot tell a new failure from the old one. The count goes up every
 * time the value arrives from nothing, which is what tells the live region to
 * speak again and a dismissed toast to come back.
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

/** A pull request asked for from the field that did not open. */
function usePullRequestToast(): ToastItem | null {
  const { prError, retryingPr } = useReviewView();
  const { dismissPrError, retryPullRequest } = useReviewControls();
  // While a pull request is being asked for again its old reason stays up,
  // busy; the reason counts as raised again when the answer lands.
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
 * Where a pressed Retry is. Waiting until its turn starts (it may be queued
 * behind one already on the wire), running until that turn settles, and back
 * to idle if the queued turn is dropped instead: every file it would have
 * sent was emptied, removed or paused, the session's budget ran out, or the
 * failure was cleared without a turn.
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

/** A judging turn that did not come back. */
function useJudgeToast(retryable: boolean): ToastItem | null {
  const { judge } = useReviewView();
  const { retryJudging } = useReviewControls();
  const raised = useRaised(judge.error);

  // A judging retry may wait behind a turn already on the wire before it
  // starts, and the failure it answers is cleared only when it does. The
  // toast stays up, busy, from the press until the retried turn settles, so
  // the button under the reader's finger never disappears.
  const [retry, setRetry] = useState<RetryPhase>(null);
  const phase = nextPhase(retry, judge, retryable);
  if (phase !== retry) {
    setRetry(phase);
  }
  // Dismissing puts this raising away, not the failure: the files it let go
  // of still say "Could not judge", and the next failure comes back.
  const [dismissed, setDismissed] = useState(0);
  // A retry that fails at once can clear and restore the failure inside one
  // render, where the count above never sees it go; each press counts too.
  const [presses, setPresses] = useState(0);

  const error = judge.error ?? (phase ? raised.last : null);
  if (!error || (phase === null && raised.count === dismissed)) {
    return null;
  }
  const trouble = describeTurnError(error);
  // Once the session's budget is spent nothing will ask again, and the notice
  // above the review says so; a failure offering to try is stale by then.
  if (trouble.retry && judge.budgetSpent) {
    return null;
  }
  // Retry only while there is something for it to send, or while the one
  // pressed is still under way.
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
 * The code view's failures, as toasts. `retryable` is whether any file a
 * failed turn let go of could be sent again. The landing view has none; there the
 * duck says it. One toast per kind, keyed by the kind, so a retry that comes
 * back with a different reason updates the toast in place and keeps focus on
 * its button.
 */
export function ReviewToasts({ retryable }: { retryable: boolean }) {
  const pr = usePullRequestToast();
  const judged = useJudgeToast(retryable);
  const toasts = [pr, judged].filter((t): t is ToastItem => t !== null);
  return <ToastRegion toasts={toasts} />;
}
