'use client';

import { useLayoutEffect, useMemo, useState } from 'react';

import { isProsePath } from '@/agent/lib/review/review';
import { Paste } from '@/src/landing/Paste';
import { Notice } from '@/src/ui/Notice';

import { isWriting, overallSummaryStatus } from './display';
import { cardId, FileCard } from './FileCard';
import { FileList } from './FileList';
import { KeepPlace } from './KeepPlace';
import { cappedText, skippedText } from './open-review';
import { ReviewNote } from './ReviewNote';
import { ReviewPills } from './ReviewPills';
import { useReviewView } from './ReviewProvider';
import { ReviewToasts } from './ReviewToasts';
import { useCardWindow } from './useCardWindow';
import type { LocalPause } from './useReview';

export function ReviewBody() {
  const { review, reviewState, edit } = useReviewView();
  const [collapsed, setCollapsed] = useState<Record<string, true>>({});
  /** `at` makes a repeat click on the same card a new value. */
  const [revealed, setRevealed] = useState<{
    index: number;
    at: number;
  } | null>(null);

  const paths = useMemo(() => review.files.map((f) => f.path), [review.files]);
  const cards = useCardWindow(review.id, paths);

  const allCollapsed =
    review.files.length > 0 &&
    review.files.every((file) => collapsed[file.path]);

  const judged = Object.keys(reviewState.judgments).length > 0;

  // When no answer can ever arrive (no code, budget spent before the first
  // answer, every file given up on), the pill must settle, not pulse forever.
  const codePaths = review.files
    .filter((file) => !isProsePath(file.path) && file.content.trim())
    .map((file) => file.path);
  const judgeable =
    codePaths.length > 0 &&
    !(reviewState.budgetSpent && !judged) &&
    !codePaths.every((path) => reviewState.givenUp[path] === true);

  // Budget-paused files show as paused instead. The hook prunes emptied and
  // removed files from `stalled`.
  const stalled = (path: string) =>
    reviewState.stalled[path] === true &&
    reviewState.pending[path] !== true &&
    reviewState.pausedFiles[path] !== true;
  // Retry is offered only while one of these is left.
  const anyStalled = Object.keys(reviewState.stalled).some(stalled);

  const proseOnly =
    review.files.length > 0 && review.files.every((f) => isProsePath(f.path));

  // Reset during render, not in an effect a frame later.
  const [foldedFor, setFoldedFor] = useState(review.id);

  if (foldedFor !== review.id) {
    setFoldedFor(review.id);
    setCollapsed({});
  }

  // After the render that unfolds the card; before it, its top is elsewhere.
  useLayoutEffect(() => {
    if (!revealed) {
      return;
    }
    document
      .getElementById(cardId(revealed.index))
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [revealed]);

  function reveal(path: string) {
    cards.jumpTo(path);
    setCollapsed((current) => {
      if (!current[path]) {
        return current;
      }
      const next = { ...current };

      delete next[path];

      return next;
    });
    setRevealed({
      at: Date.now(),
      index: review.files.findIndex((f) => f.path === path),
    });
  }

  const skipped = skippedText(
    review.skipped,
    Math.max(review.skipped.length, review.skippedCount),
  );
  const selection = [cappedText(review), skipped && `${skipped}.`]
    .filter(Boolean)
    .join(' ');
  const footnote = selection ? (
    <p
      className="mt-2 border-t border-line pt-1.5 text-xs leading-relaxed text-muted"
      data-files="selection"
    >
      {selection}
    </p>
  ) : null;

  return (
    <>
      <div className="mb-4">
        {judged ? (
          <ReviewNote
            decision={reviewState.summary.decision}
            error={reviewState.summary.error}
            footnote={footnote}
            incomplete={reviewState.summary.incomplete.overall === true}
            model={reviewState.summary.model}
            pills={
              <ReviewPills
                judgeable={judgeable}
                review={reviewState}
                stalled={anyStalled}
              />
            }
            status={overallSummaryStatus(reviewState.summary)}
            text={reviewState.summary.overall}
            tone="overall"
            writing={isWriting(reviewState.summary, 'overall')}
          />
        ) : (
          // Keeps the verdict pills in place before there is a review.
          <section
            className="rounded-md border border-line bg-surface px-3 py-2"
            data-overall="placeholder"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ReviewPills
                judgeable={judgeable}
                review={reviewState}
                stalled={anyStalled}
              />
            </div>
            {footnote}
          </section>
        )}
      </div>

      {reviewState.budgetSpent ? <BudgetSpent /> : null}
      {reviewState.paused && !reviewState.budgetSpent ? (
        <ReviewsPaused paused={reviewState.paused} />
      ) : null}
      {proseOnly ? <NothingToJudge /> : null}
      <Paste />
      {/* Keyed so a retry's busy state does not carry over to a new review. */}
      <ReviewToasts key={review.id} retryable={anyStalled} />

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <FileList
          allCollapsed={allCollapsed}
          failed={reviewState.givenUp}
          files={review.files}
          judgments={reviewState.judgments}
          onSelect={reveal}
          onToggleAll={() =>
            setCollapsed(
              allCollapsed
                ? {}
                : Object.fromEntries(
                    review.files.map((f) => [f.path, true as const]),
                  ),
            )
          }
          paused={reviewState.pausedFiles}
          stalled={stalled}
        />
        <KeepPlace className="flex min-w-0 flex-col gap-4" drawn={cards.drawn}>
          {review.files.map((file, index) => (
            <FileCard
              collapsed={collapsed[file.path] === true}
              deferred={!cards.isDrawn(index, file.path)}
              failed={reviewState.givenUp[file.path] === true}
              file={file}
              index={index}
              judgment={reviewState.judgments[file.path]}
              key={file.path}
              onChange={(content) => edit(file.path, content)}
              onToggle={() =>
                setCollapsed((current) => {
                  const next = { ...current };

                  if (next[file.path]) {
                    delete next[file.path];
                  } else {
                    next[file.path] = true;
                  }

                  return next;
                })
              }
              paused={
                reviewState.pausedFiles[file.path] === true &&
                reviewState.pending[file.path] !== true
              }
              stalled={stalled(file.path)}
              summary={reviewState.summary}
              truncated={review.truncated[file.path] === true}
              watch={cards.watch}
            />
          ))}
        </KeepPlace>
      </div>
      {/* Sized by `ToastRegion` so the last lines can scroll out from under
          phone toasts. */}
      <div aria-hidden="true" className="lg:hidden" data-toast-room={true} />
    </>
  );
}

function NothingToJudge() {
  return (
    <Notice data-files="prose-only">
      Nothing to judge: every file in this review is prose. They are shown as
      they were written, and neither model was asked about them.
    </Notice>
  );
}

/** The per-session cost cap in agent.ts; permanent for the tab. */
function BudgetSpent() {
  return (
    <Notice data-budget="spent" tone="warn">
      <strong className="font-semibold">
        This session has reached its limit.
      </strong>{' '}
      The meters are frozen on the last answers — reload for a fresh session.
    </Notice>
  );
}

const MS_PER_MINUTE = 60_000;
/** `HH:MM` within an ISO timestamp. */
const CLOCK_FROM = 11;
const CLOCK_TO = 16;

/** Rounded up, so it never shows a time before the real one. */
function clock(ms: number): string {
  const minute = Math.ceil(ms / MS_PER_MINUTE) * MS_PER_MINUTE;

  return `${new Date(minute).toISOString().slice(CLOCK_FROM, CLOCK_TO)} UTC`;
}

/** The site-wide model budget, unlike the session cap, resets on its own. */
function ReviewsPaused({ paused }: { paused: LocalPause }) {
  if (paused.window === 'unavailable') {
    return (
      <Notice data-budget="paused" data-window={paused.window} tone="warn">
        <strong className="font-semibold">Reviews are paused for now.</strong>{' '}
        The review budget cannot be checked, so no new work starts. The page
        asks again at {clock(paused.resumeAt)}. The answers on screen stay as
        they are.
      </Notice>
    );
  }
  const day = paused.window === 'day';
  const at = day ? 'midnight UTC' : clock(Date.parse(paused.resetsAt));

  return (
    <Notice data-budget="paused" data-window={paused.window} tone="warn">
      <strong className="font-semibold">
        {day ? "Today's" : "This hour's"} review budget is spent.
      </strong>{' '}
      Reviews come back at {at}, without a reload. The answers on screen stay as
      they are.
    </Notice>
  );
}
