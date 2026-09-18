'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';

import {
  HOST_PREFIX,
  PULL_INFIX,
  pullRequestUrl,
  splitPullRequest,
} from '@/lib/address';

import { useReviewControls } from './ReviewProvider';

/**
 * The way in: the address is on screen with only its two variable parts left
 * to type — `owner/repo` and the number — and Enter in either box judges it.
 * A whole URL pasted into the first box is taken apart rather than rejected,
 * because pasting one is what anyone coming from GitHub will do.
 *
 * Public repositories only — the action carries nobody's token, and a private
 * pull request comes back as "not found" rather than as an invitation to sign in.
 *
 * The two fixed labels are drawn here rather than handed in from the server:
 * they are inside the field's own focus ring and its own flex row, and moving
 * two spans across the boundary would buy nothing — this component ships
 * either way, and the markup would only move from its bundle to every request.
 *
 * `duck` is the mascot, rendered on the server and handed in: in the code view
 * it stands at the left of this row and is the way back out of the review, and
 * on the landing view it renders nothing, because there it is the large one
 * above. It is a node rather than an import so that `next/image` stays out of
 * this component's bundle.
 */
export function PullRequestField({ duck }: { duck?: ReactNode }) {
  const { address, openPullRequest, fetching } = useReviewControls();
  // A permalink arrives with the request already named, and the field is where
  // that name belongs: the URL and the boxes say the same thing from the first
  // paint, so editing one digit is how you get to the next pull request.
  const [repo, setRepo] = useState(address.repo);
  const [number, setNumber] = useState(address.number);
  const repoRef = useRef<HTMLInputElement>(null);
  const numberRef = useRef<HTMLInputElement>(null);
  /** What the boxes were last filled from, so a re-render is not a refill. */
  const filled = useRef(`${address.repo}${PULL_INFIX}${address.number}`);

  // Back and Forward open another pull request without going through this
  // form, and the boxes are part of the address: they follow it. What they do
  // not do is take it away from whoever is using them — a review closing names
  // nothing, and a cursor in either box means that box is being typed in.
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

  /** A pasted address fills both boxes and moves on to the button. */
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
      {/* The duck, the address, the button: one line, at every width. The
          address is what it is on GitHub — a single line — and it stays one
          here even on a phone, because an address broken over two rows stops
          being an address and becomes a form. What gives instead is the type
          in the fixed parts (twelve pixels, which is a label, not an input)
          and the padding around them; what never gives is the sixteen pixels
          in the two boxes that are typed into, below which iOS zooms the page
          in on focus and never zooms back out.
          Only the button leaves the row, and only under 480px, where a compact
          one beside the field would take the last of the space `owner/repo`
          has. `flex-wrap` and a full width are the whole mechanism: at that
          size the button cannot share the line, so it takes its own. */}
      <div className="flex flex-wrap items-center gap-2">
        {duck}
        <div className="flex min-h-11 min-w-0 flex-1 items-stretch rounded-md border border-line bg-page focus-within:border-accent lg:min-h-0 lg:min-w-[12rem]">
          <span className="flex shrink-0 items-center border-r border-line pr-2 pl-2.5 font-mono text-[12px] text-muted select-none lg:py-2 lg:text-[13px]">
            {HOST_PREFIX}
          </span>
          <input
            aria-label="GitHub owner and repository"
            autoComplete="off"
            className="w-full min-w-0 flex-1 bg-transparent px-2 font-mono text-[16px] text-ink outline-none placeholder:text-muted/60 lg:px-2.5 lg:py-2 lg:text-[13px]"
            data-pr-repo={true}
            onChange={(e) => {
              // A paste lands here as a change too (keyboard, menu or drop),
              // so the whole URL is taken apart wherever it came from.
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
            // `min-w-0` is what keeps the row a row: without it an input's
            // default intrinsic width is the floor the line cannot go under,
            // and the field would push the page sideways on a phone.
            value={repo}
          />
          <span className="flex shrink-0 items-center border-l border-line pr-0.5 pl-2 font-mono text-[12px] text-muted select-none lg:text-[13px]">
            {PULL_INFIX}
          </span>
          <input
            aria-label="Pull request number"
            autoComplete="off"
            className="w-14 min-w-0 shrink-0 bg-transparent px-2 font-mono text-[16px] text-ink outline-none placeholder:text-muted/60 lg:w-16 lg:px-2.5 lg:py-2 lg:text-[13px]"
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
          className="min-h-11 w-full shrink-0 cursor-pointer rounded-md bg-ink px-3 text-[14px] font-semibold whitespace-nowrap text-page disabled:cursor-default disabled:opacity-40 min-[480px]:w-auto lg:min-h-0 lg:px-3.5 lg:py-2 lg:text-[13px]"
          disabled={!ready || fetching}
          type="submit"
        >
          {fetching ? 'Fetching…' : 'Judge'}
        </button>
      </div>
    </form>
  );
}
