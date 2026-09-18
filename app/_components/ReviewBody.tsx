'use client';

import { useLayoutEffect, useState } from 'react';

import { isProsePath } from '@/agent/lib/review';
import { isWriting, overallSummaryStatus } from '@/lib/display';
import { cappedText, skippedText } from '@/lib/open-review';

import { cardId, FileCard } from './FileCard';
import { FileList } from './FileList';
import { Notice } from './Notice';
import { Paste } from './Paste';
import { ReviewNote } from './ReviewNote';
import { ReviewPills } from './ReviewPills';
import { useReviewView } from './ReviewProvider';

/**
 * The review itself: the verdict across the top, whatever had to be said about
 * what was left out, and then the files — a list beside them and a card each.
 *
 * This is the part of the page that cannot be anything but a client component:
 * every card is editable, every judgment arrives over a stream, and folding one
 * is a click. The frame around it — the header, the questions, the footer — is
 * rendered on the server and never enters this tree.
 */
export function ReviewBody() {
  const { review, judge, prError, edit } = useReviewView();
  /** Paths folded to their header. Per review: another example starts open. */
  const [collapsed, setCollapsed] = useState<Record<string, true>>({});
  /** The card the sidebar was last clicked for, scrolled to once it is open. */
  const [revealed, setRevealed] = useState<{ path: string; at: number } | null>(
    null,
  );

  const allCollapsed =
    review.files.length > 0 &&
    review.files.every((file) => collapsed[file.path]);

  /** Whether anything has been judged yet, which is what the review is of. */
  const judged = Object.keys(judge.judgments).length > 0;

  // Is there anything here to judge at all? A documentation-only change has no
  // code file in it, so no judging turn is ever started and nothing will ever
  // arrive: the review has to say so rather than pulse "Judging…" for the life
  // of the tab.
  const codePaths = review.files
    .filter((file) => !isProsePath(file.path) && file.content.trim())
    .map((file) => file.path);
  // Nor will anything arrive once the session's budget went before the first
  // answer did, or when Jev was asked about every code file twice and answered
  // for none: the pill has to settle rather than wait.
  const judgeable =
    codePaths.length > 0 &&
    !(judge.budgetSpent && !judged) &&
    !codePaths.every((path) => judge.failed[path] === true);

  /** Every file here is writing: a docs-only pull request, or a paste of one. */
  const proseOnly =
    review.files.length > 0 && review.files.every((f) => isProsePath(f.path));

  // Folding is about this review's files; another example is a fresh page.
  // Reset during the render that carries the new review rather than in an
  // effect a frame later, so no card is ever folded from the last one.
  const [foldedFor, setFoldedFor] = useState(review.id);
  if (foldedFor !== review.id) {
    setFoldedFor(review.id);
    setCollapsed({});
  }

  // A card is scrolled to after the render that opened it, not before: a
  // folded card is a header tall, and its top is not where it will be.
  useLayoutEffect(() => {
    if (!revealed) {
      return;
    }
    document
      .getElementById(cardId(revealed.path))
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [revealed]);

  /** The sidebar's click: unfold that file and bring it into view. */
  function reveal(path: string) {
    setCollapsed((current) => {
      if (!current[path]) {
        return current;
      }
      const next = { ...current };
      delete next[path];
      return next;
    });
    setRevealed({ at: Date.now(), path });
  }

  const selectionNotice = [
    skippedText(
      review.skipped,
      Math.max(review.skipped.length, review.skippedCount),
    ),
  ]
    .filter(Boolean)
    .join(' · ');

  const capped = cappedText(review);

  return (
    <>
      <div className="mb-4">
        {judged ? (
          <ReviewNote
            decision={judge.summary.decision}
            error={judge.summary.error}
            model={judge.summary.model}
            pills={<ReviewPills judgeable={judgeable} review={judge} />}
            status={overallSummaryStatus(judge.summary)}
            text={judge.summary.overall}
            tone="overall"
            writing={isWriting(judge.summary, 'overall')}
          />
        ) : (
          // Nothing has been judged yet, so there is no review to carry the
          // pills — but the page must never be without its verdict. The same
          // row, in the same place, with the card stripped to just that line.
          <section
            className="rounded-md border border-line bg-surface px-3 py-2"
            data-overall="placeholder"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ReviewPills judgeable={judgeable} review={judge} />
            </div>
          </section>
        )}
      </div>

      {judge.budgetSpent ? <BudgetSpent /> : null}
      {prError ? <Notice data-pr="error">{prError}</Notice> : null}
      {selectionNotice && (
        <Notice data-files="skipped">{selectionNotice}</Notice>
      )}
      {capped && <Notice data-files="capped">{capped}</Notice>}
      {proseOnly ? <NothingToJudge /> : null}
      <Paste />

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <FileList
          allCollapsed={allCollapsed}
          failed={judge.failed}
          files={review.files}
          judgments={judge.judgments}
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
        />
        <div className="flex min-w-0 flex-col gap-4">
          {review.files.map((file) => (
            <FileCard
              collapsed={collapsed[file.path] === true}
              failed={judge.failed[file.path] === true}
              file={file}
              judgment={judge.judgments[file.path]}
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
              pending={judge.pending[file.path] === true}
              summary={judge.summary}
              truncated={review.truncated[file.path] === true}
            />
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * A change with no code in it. Clean Code is a book about code, so there is
 * nothing here any of the questions is about — and, unlike a review that is
 * still running, nothing is coming either.
 */
function NothingToJudge() {
  return (
    <Notice data-files="prose-only">
      Nothing to judge: every file in this review is prose. They are shown as
      they were written, and neither model was asked about them.
    </Notice>
  );
}

/**
 * Each tab is one durable eve session, capped at a fixed amount in agent.ts.
 * This is what running into that cap looks like: eve parked the turn asking
 * whether to keep spending, and a demo has nobody to ask.
 */
function BudgetSpent() {
  return (
    <Notice data-budget="spent">
      <strong className="font-semibold">
        This session has reached its limit.
      </strong>{' '}
      The meters are frozen on the last answers — reload for a fresh session.
    </Notice>
  );
}
