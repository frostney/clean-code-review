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
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* The second half of the address wraps onto its own line on a narrow
            screen rather than squeezing `owner/repo` down to two characters. */}
        <div className="flex min-w-[12rem] flex-1 flex-wrap items-center rounded-md border border-line bg-white focus-within:border-accent">
          <span className="shrink-0 border-r border-line py-2 pr-2 pl-2.5 font-mono text-[13px] text-muted select-none">
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
            className="min-w-[7rem] flex-1 bg-transparent px-2.5 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-muted/60"
          />
          <span className="shrink-0 border-l border-line py-2 pr-2 pl-2 font-mono text-[13px] text-muted select-none">
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
            className="w-16 shrink-0 bg-transparent px-2.5 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-muted/60"
          />
        </div>
        <button
          type="submit"
          disabled={!ready || fetching}
          className="shrink-0 cursor-pointer rounded-md bg-ink px-3.5 py-2 text-[13px] font-semibold text-white disabled:cursor-default disabled:opacity-40"
        >
          {fetching ? "Fetching…" : "Judge"}
        </button>
      </div>
    </form>
  );
}
