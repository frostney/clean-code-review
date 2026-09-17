'use client';

import { type ReactNode, useRef, useState } from 'react';

import { useReviewControls } from './ReviewProvider';

/** The fixed parts of the address; only what is between them is typed. */
const PREFIX = 'github.com/';
const INFIX = '/pull/';

/** `github.com/vercel/ai/pull/20851`, in any of the shapes a paste takes. */
const PR_URL =
  /(?:^|\/\/)(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i;

/** A bare `owner/repo/pull/123`, which is what the old single field took. */
const PR_PATH = /^([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/i;

/**
 * The two typed parts of a pull request's address, as the field holds them.
 * A paste that carries the whole URL fills both; anything else is left alone
 * for the repo box, because a half-typed `owner/` is not a mistake.
 */
export function splitPullRequest(
  pasted: string,
): { repo: string; number: string } | null {
  const text = pasted.trim();
  const url = PR_URL.exec(text) ?? PR_PATH.exec(text);
  return url ? { number: url[2], repo: url[1].replace(/\.git$/i, '') } : null;
}

/** The address the action is asked for, from the two parts of the field. */
export function pullRequestUrl(repo: string, number: string): string {
  const owner = repo.trim().replace(/^\/+|\/+$/g, '');
  return `https://${PREFIX}${owner}${INFIX}${number.trim()}`;
}

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
 * `duck` is the mascot, rendered on the server and handed in: it stands at the
 * left of this row rather than above it, because the page has no title and the
 * duck is what says which page this is. It is a node rather than an import so
 * that `next/image` stays out of this component's bundle.
 */
export function PullRequestField({ duck }: { duck?: ReactNode }) {
  const { openPullRequest, fetching } = useReviewControls();
  const [repo, setRepo] = useState('');
  const [number, setNumber] = useState('');
  const numberRef = useRef<HTMLInputElement>(null);

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
            {PREFIX}
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
            spellCheck={false}
            type="text"
            // `min-w-0` is what keeps the row a row: without it an input's
            // default intrinsic width is the floor the line cannot go under,
            // and the field would push the page sideways on a phone.
            value={repo}
          />
          <span className="flex shrink-0 items-center border-l border-line pr-0.5 pl-2 font-mono text-[12px] text-muted select-none lg:text-[13px]">
            {INFIX}
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
