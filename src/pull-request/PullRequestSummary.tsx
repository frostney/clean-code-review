'use client';

import Image from 'next/image';
import { useState } from 'react';

import { useReviewControls, useReviewView } from '@/src/review/ReviewProvider';
import { Notice } from '@/src/ui/Notice';

import { splitPullRequest } from './address';
import { describePullRequestError } from './errors';
import { PullRequestBodyToggle } from './PullRequestBodyToggle';

// The owner/repo line exists because a title never says which repository a
// change is in, which a reader arriving by link cannot otherwise tell.

const AVATAR_PX = 20;

/** 2x for high-density screens. */
const AVATAR_REQUEST_PX = AVATAR_PX * 2;

/** GitHub resizes its own avatars via `s=`. */
function sized(src: string): string {
  return `${src}${src.includes('?') ? '&' : '?'}s=${AVATAR_REQUEST_PX}`;
}

/**
 * A failed load removes the image (the line already names the owner); keyed on
 * the URL so the next project gets a fresh attempt. `unoptimized`: allowing
 * GitHub in `next.config.ts` would make `/_next/image` a public billed proxy.
 */
function OwnerAvatar({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);

  if (!src || broken) {
    return null;
  }

  return (
    <Image
      alt=""
      className="shrink-0 rounded-md border border-line"
      data-pr-avatar={true}
      height={AVATAR_PX}
      onError={() => setBroken(true)}
      src={sized(src)}
      unoptimized={true}
      width={AVATAR_PX}
    />
  );
}

/**
 * Where the title will be, so the wait is visible without standing in the
 * review's room: anything down there would be pushed by the title and the
 * description arriving above it. A live region, because the press leaves the
 * button reading "Fetching…" and changes nothing else a screen reader is
 * looking at — without this, nothing would say what the page is waiting on.
 */
function Fetching() {
  return (
    <output
      className="mt-3 flex items-center gap-2 text-base text-muted lg:text-sm"
      data-pr-fetching={true}
    >
      <span aria-hidden="true" className="spinner" />
      Fetching the pull request…
    </output>
  );
}

const ANSWER_BUTTON =
  'inline-flex min-h-10 shrink-0 cursor-pointer items-center rounded underline decoration-current/40 underline-offset-2 hover:decoration-current aria-disabled:cursor-default aria-disabled:no-underline lg:min-h-0';

/**
 * A refusal is answered here, in the layout the press already gave the page.
 * Putting the landing view back to say it would move everything the press
 * settled, a second or more after the press, which is a shift the reader never
 * asked for; the duck says it on the landing view, where nothing has moved.
 */
function Refused({ message }: { message: string }) {
  const { retryingPr } = useReviewView();
  const { dismissPrError, retryPullRequest } = useReviewControls();
  const trouble = describePullRequestError(message);

  return (
    <Notice
      className="mt-3 mb-0 flex flex-wrap items-center gap-x-4 gap-y-1"
      data-pr-refused={true}
      tone="error"
    >
      {/* The sentence alone is the alert: over the whole notice it would be
          read out as "…Retry. Start again." every time, which is what the
          toasts are built to avoid. */}
      <span className="min-w-0 flex-1 basis-60" role="alert">
        {trouble.sentence}
      </span>
      {trouble.retry ? (
        <button
          // Not `disabled`: a disabled button drops the focus that pressed it.
          aria-disabled={retryingPr}
          className={ANSWER_BUTTON}
          data-pr-refused="retry"
          onClick={retryingPr ? undefined : retryPullRequest}
          type="button"
        >
          {retryingPr ? 'Retrying…' : 'Retry'}
        </button>
      ) : null}
      <button
        className={ANSWER_BUTTON}
        data-pr-refused="dismiss"
        // The address is the thing to fix, and this button is about to leave
        // the document, so the focus that pressed it is handed on rather than
        // dropped on `<body>`.
        onClick={(event) => {
          const pressed = document.activeElement === event.currentTarget;

          dismissPrError();
          if (pressed) {
            // A task, not a frame: a page the browser is not painting produces
            // no frames, and the focus would be dropped on `<body>`.
            setTimeout(() => {
              document
                .querySelector<HTMLInputElement>('[data-pr-repo]')
                ?.focus();
            }, 0);
          }
        }}
        type="button"
      >
        Start again
      </button>
    </Notice>
  );
}

export function PullRequestSummary() {
  const { committed, open, prError, review } = useReviewView();
  const pr = review.pr;

  if (!pr) {
    if (open || !committed) {
      return null;
    }

    return prError === null ? <Fetching /> : <Refused message={prError} />;
  }
  // Not a truthiness test: `ReactNode` includes a promise.
  const hasBody = pr.body !== undefined && pr.body !== null;
  const address = splitPullRequest(pr.url);

  return (
    <>
      <div className="mt-3 min-w-0">
        {address ? (
          <p
            className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted"
            data-pr-name={true}
          >
            <OwnerAvatar key={pr.avatarUrl} src={pr.avatarUrl} />
            <span className="truncate">
              {address.repo}#{address.number}
            </span>
          </p>
        ) : null}
        {/* Larger than any heading the description can set, and in ink rather
            than link colour, so it reads as the subject. */}
        <h2 className="min-w-0 text-lg leading-snug font-semibold text-ink">
          {pr.url ? (
            <a
              className="inline-flex min-h-10 items-center decoration-accent underline-offset-4 hover:text-accent hover:underline lg:min-h-0"
              data-pr-title={true}
              href={pr.url}
              rel="noreferrer"
              target="_blank"
            >
              {pr.title}
            </a>
          ) : (
            <span data-pr-title={true}>{pr.title}</span>
          )}
        </h2>
      </div>
      {hasBody ? (
        <PullRequestBodyToggle>{pr.body}</PullRequestBodyToggle>
      ) : null}
    </>
  );
}
