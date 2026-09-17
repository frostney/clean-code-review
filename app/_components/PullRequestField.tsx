"use client";

import { useRef, useState } from "react";
import { useReviewControls } from "./ReviewProvider";

/** The fixed parts of the address; only what is between them is typed. */
const PREFIX = "github.com/";
const INFIX = "/pull/";

/** `github.com/vercel/ai/pull/20851`, in any of the shapes a paste takes. */
const PR_URL = /(?:^|\/\/)(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i;

/** A bare `owner/repo/pull/123`, which is what the old single field took. */
const PR_PATH = /^([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/i;

/**
 * The two typed parts of a pull request's address, as the field holds them.
 * A paste that carries the whole URL fills both; anything else is left alone
 * for the repo box, because a half-typed `owner/` is not a mistake.
 */
export function splitPullRequest(pasted: string): { repo: string; number: string } | null {
  const text = pasted.trim();
  const url = PR_URL.exec(text) ?? PR_PATH.exec(text);
  return url ? { repo: url[1].replace(/\.git$/i, ""), number: url[2] } : null;
}

/** The address the action is asked for, from the two parts of the field. */
export function pullRequestUrl(repo: string, number: string): string {
  const owner = repo.trim().replace(/^\/+|\/+$/g, "");
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
 */
export function PullRequestField() {
  const { openPullRequest, fetching } = useReviewControls();
  const [repo, setRepo] = useState("");
  const [number, setNumber] = useState("");
  const numberRef = useRef<HTMLInputElement>(null);

  const ready = !!repo.trim() && !!number.trim();

  /** A pasted address fills both boxes and moves on to the button. */
  function takeApart(text: string): boolean {
    const parts = splitPullRequest(text);
    if (!parts) return false;
    setRepo(parts.repo);
    setNumber(parts.number);
    return true;
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || fetching) return;
        openPullRequest(pullRequestUrl(repo, number));
      }}
    >
      {/* One box, two halves. Wide enough, the address is the single line it
          is on GitHub. On a phone the halves become two rows of the same box —
          `github.com/ owner/repo` over `/pull/ 123` — because squeezing
          `owner/repo` into the ninety pixels left beside a number field is the
          one thing this field must never do, and the button drops below them
          at full width rather than stealing that space back.
          Two breakpoints, because they answer different questions: the shape
          goes back to one line as soon as one line fits (`sm`), while the
          sixteen-pixel type and the forty-four-pixel rows hold until the
          layout is wide enough to be a pointer's (`lg`). */}
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col rounded-md border border-line bg-white focus-within:border-accent sm:flex-row sm:items-center lg:min-w-[12rem]">
          <div className="flex min-h-11 min-w-0 flex-1 items-stretch border-b border-line sm:border-b-0 lg:min-h-0">
            <span className="flex shrink-0 items-center border-r border-line pr-2 pl-2.5 font-mono text-[16px] text-muted select-none lg:py-2 lg:text-[13px]">
              {PREFIX}
            </span>
            <input
              type="text"
              data-pr-repo
              value={repo}
              onChange={(e) => {
                // A paste lands here as a change too (keyboard, menu or drop),
                // so the whole URL is taken apart wherever it came from.
                if (!takeApart(e.target.value)) setRepo(e.target.value);
              }}
              onPaste={(e) => {
                if (takeApart(e.clipboardData.getData("text"))) {
                  e.preventDefault();
                  numberRef.current?.focus();
                }
              }}
              spellCheck={false}
              autoComplete="off"
              placeholder="owner/repo"
              aria-label="GitHub owner and repository"
              // Sixteen pixels is not a taste: below it iOS zooms the page in
              // on focus and never zooms back out.
              className="w-full min-w-[7rem] flex-1 bg-transparent px-2.5 font-mono text-[16px] text-ink outline-none placeholder:text-muted/60 lg:py-2 lg:text-[13px]"
            />
          </div>
          <div className="flex min-h-11 items-stretch lg:min-h-0">
            <span className="flex shrink-0 items-center border-r border-line pr-2 pl-2.5 font-mono text-[16px] text-muted select-none sm:border-r-0 sm:border-l lg:py-2 lg:pl-2 lg:text-[13px]">
              {INFIX}
            </span>
            <input
              ref={numberRef}
              type="text"
              inputMode="numeric"
              data-pr-number
              value={number}
              onChange={(e) => {
                if (!takeApart(e.target.value)) setNumber(e.target.value.replace(/[^\d]/g, ""));
              }}
              spellCheck={false}
              autoComplete="off"
              placeholder="123"
              aria-label="Pull request number"
              className="w-full flex-1 bg-transparent px-2.5 font-mono text-[16px] text-ink outline-none placeholder:text-muted/60 sm:w-20 sm:flex-none lg:w-16 lg:py-2 lg:text-[13px]"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={!ready || fetching}
          className="min-h-11 w-full shrink-0 cursor-pointer rounded-md bg-ink px-3.5 text-[15px] font-semibold text-white disabled:cursor-default disabled:opacity-40 sm:w-auto lg:min-h-0 lg:py-2 lg:text-[13px]"
        >
          {fetching ? "Fetching…" : "Judge"}
        </button>
      </div>
    </form>
  );
}
