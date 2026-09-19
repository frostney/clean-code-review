'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';

import { useReviewControls } from '@/src/review/ReviewProvider';

import {
  HOST_PREFIX,
  PULL_INFIX,
  pullRequestUrl,
  splitPullRequest,
} from './address';

/**
 * A whole URL pasted into the first box is taken apart, not rejected.
 * `duck` is a server-rendered node so `next/image` stays out of this bundle.
 */
export function PullRequestField({ duck }: { duck?: ReactNode }) {
  const { address, openPullRequest, fetching } = useReviewControls();
  const [repo, setRepo] = useState(address.repo);
  const [number, setNumber] = useState(address.number);
  const repoRef = useRef<HTMLInputElement>(null);
  const numberRef = useRef<HTMLInputElement>(null);
  const filled = useRef(`${address.repo}${PULL_INFIX}${address.number}`);

  // Follow Back/Forward, but never overwrite a box that has focus, and keep the
  // boxes when a review closes.
  useEffect(() => {
    const next = `${address.repo}${PULL_INFIX}${address.number}`;
    if (next === filled.current || !address.repo) {
      return;
    }
    const typing =
      document.activeElement === repoRef.current ||
      document.activeElement === numberRef.current;
    if (typing) {
      return;
    }
    filled.current = next;
    setRepo(address.repo);
    setNumber(address.number);
  }, [address]);

  const ready = repo.trim() !== '' && number.trim() !== '';

  function takeApart(text: string): boolean {
    const parts = splitPullRequest(text);
    if (!parts) {
      return false;
    }
    setRepo(parts.repo);
    setNumber(parts.number);
    return true;
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || fetching) {
          return;
        }
        openPullRequest(pullRequestUrl(repo, number));
      }}
    >
      {/* One line at every width. The typed boxes stay 16px (text-lg) below
          `lg`: under 16px iOS zooms in on focus and never zooms back out. Under
          480px the button wraps to its own full-width row. */}
      <div className="flex flex-wrap items-center gap-2">
        {duck}
        <div className="flex min-h-11 min-w-0 flex-1 items-stretch rounded-md border border-line-strong bg-page focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent lg:min-h-0 lg:min-w-[12rem]">
          <span className="flex shrink-0 items-center border-r border-line pr-2 pl-2.5 font-mono text-xs text-muted select-none lg:py-2 lg:text-sm">
            {HOST_PREFIX}
          </span>
          <input
            aria-label="GitHub owner and repository"
            autoComplete="off"
            // `min-w-0`: an input's intrinsic width would push the page sideways.
            className="w-full min-w-0 flex-1 bg-transparent px-2 font-mono text-lg text-ink outline-none placeholder:text-subtle lg:px-2.5 lg:py-2 lg:text-sm"
            data-pr-repo={true}
            onChange={(e) => {
              // Menu paste and drop arrive only as a change.
              if (!takeApart(e.target.value)) {
                setRepo(e.target.value);
              }
            }}
            onPaste={(e) => {
              if (takeApart(e.clipboardData.getData('text'))) {
                e.preventDefault();
                numberRef.current?.focus();
              }
            }}
            placeholder="owner/repo"
            ref={repoRef}
            spellCheck={false}
            type="text"
            value={repo}
          />
          <span className="flex shrink-0 items-center border-l border-line pr-0.5 pl-2 font-mono text-xs text-muted select-none lg:text-sm">
            {PULL_INFIX}
          </span>
          <input
            aria-label="Pull request number"
            autoComplete="off"
            className="w-14 min-w-0 shrink-0 bg-transparent px-2 font-mono text-lg text-ink outline-none placeholder:text-subtle lg:w-16 lg:px-2.5 lg:py-2 lg:text-sm"
            data-pr-number={true}
            inputMode="numeric"
            onChange={(e) => {
              if (!takeApart(e.target.value)) {
                setNumber(e.target.value.replace(/[^\d]/g, ''));
              }
            }}
            placeholder="123"
            ref={numberRef}
            spellCheck={false}
            type="text"
            value={number}
          />
        </div>
        <button
          className="min-h-11 w-full shrink-0 cursor-pointer rounded-md bg-ink px-3 text-base font-semibold whitespace-nowrap text-page disabled:cursor-default disabled:bg-surface disabled:text-muted disabled:ring-1 disabled:ring-line disabled:ring-inset min-[480px]:w-auto lg:min-h-0 lg:px-3.5 lg:py-2 lg:text-sm"
          disabled={!ready || fetching}
          type="submit"
        >
          {/* Both labels share one grid cell, so the button never resizes. */}
          <span className="grid">
            <span className={`[grid-area:1/1] ${fetching ? 'invisible' : ''}`}>
              Judge
            </span>
            <span className={`[grid-area:1/1] ${fetching ? '' : 'invisible'}`}>
              Fetching…
            </span>
          </span>
        </button>
      </div>
    </form>
  );
}
