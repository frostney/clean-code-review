"use client";

import { type RefObject, useRef, useState } from "react";
import type { Preset } from "@/agent/lib/presets";
import { SESSION_BUDGET_USD } from "@/lib/budget";
import { meanVerdict, smellCount, smellLabel, verdictOf, verdictScore } from "@/lib/display";
import type { PullRequestContext, ReviewState } from "@/lib/useReview";
import { PullRequestBody } from "./PullRequestBody";

/**
 * The top of a pull request: what this is, what the reviewer concluded, and
 * the numbers behind it.
 *
 * A pull request is the way in, so it is the first thing under the title: one
 * field with `github.com/` already typed into it. The examples and the paste
 * box sit below as the secondary way in, because choosing what to review is
 * part of the same header, not a sidebar.
 */
export function ReviewHeader({
  review,
  presets,
  activePreset,
  onPick,
  onPaste,
  pasteButtonRef,
  onOpenPullRequest,
  fetching,
  pr,
  fileCount,
  lineCount,
}: {
  review: ReviewState;
  presets: readonly Preset[];
  activePreset: string | null;
  onPick: (preset: Preset) => void;
  onPaste: () => void;
  /** The dialog hands focus back here when it closes. */
  pasteButtonRef?: RefObject<HTMLButtonElement | null>;
  /** The full `https://github.com/…` URL the field was typed into. */
  onOpenPullRequest: (url: string) => void;
  fetching: boolean;
  /** Set when this review came from a GitHub pull request. */
  pr: PullRequestContext | null;
  fileCount: number;
  lineCount: number;
}) {
  // The review's own verdict: what Jev said about every file it has judged.
  const judged = Object.values(review.judgments);
  const verdict = verdictOf(meanVerdict(judged.map((j) => verdictScore(j.answers))));
  const smells = judged.reduce((total, j) => total + smellCount(j.answers), 0);
  const cached = review.cached || review.summary.cached;

  return (
    <header className="mb-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Clean Code Judge</h1>
        <span
          data-verdict={verdict.key}
          className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${verdict.className}`}
        >
          {verdict.key === "pending" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted" />}
          {verdict.label}
        </span>
        {judged.length > 0 && (
          <span
            data-smells-total={smells}
            className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${
              smells ? "bg-bad-bg text-bad" : "bg-track text-muted"
            }`}
          >
            {smellLabel(smells)}
          </span>
        )}
        <Status review={review} />
      </div>

      <PullRequestField onOpen={onOpenPullRequest} busy={fetching} />

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="text-[12px] text-muted">Or choose one of the examples:</span>
        {presets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            title={preset.blurb}
            onClick={() => onPick(preset)}
            className={`cursor-pointer rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
              activePreset === preset.label
                ? "border-ink bg-ink text-white"
                : "border-line bg-white text-muted hover:border-muted hover:text-ink"
            }`}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          ref={pasteButtonRef}
          data-paste="open"
          onClick={onPaste}
          className="cursor-pointer text-[12px] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          Paste code or a diff
        </button>
      </div>

      {pr && (
        <p className="mt-3 min-w-0 text-[13px]">
          {pr.url ? (
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              data-pr-title
              className="font-semibold text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
            >
              {pr.title}
            </a>
          ) : (
            <span data-pr-title className="font-semibold text-ink">
              {pr.title}
            </span>
          )}
        </p>
      )}
      {pr?.body?.trim() && <PullRequestBody body={pr.body} />}

      <p className="mt-2 text-[12px] text-muted">
        {fileCount} {fileCount === 1 ? "file" : "files"} · {lineCount} lines · last turn{" "}
        {review.ms === null ? "—" : `${review.ms} ms`} · ${review.spentUsd.toFixed(4)} of $
        {SESSION_BUDGET_USD.toFixed(2)} session budget
        {cached && (
          <>
            {" · "}
            <span data-cached="1" className="text-muted/70">
              from cache
            </span>
          </>
        )}
      </p>

    </header>
  );
}

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

/** The address the route is asked for, from the two parts of the field. */
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
 * Public repositories only — the route carries nobody's token, and a private
 * pull request comes back as "not found" rather than as an invitation to sign in.
 */
function PullRequestField({ onOpen, busy }: { onOpen: (url: string) => void; busy: boolean }) {
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
      className="mt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || busy) return;
        onOpen(pullRequestUrl(repo, number));
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
          disabled={!ready || busy}
          className="shrink-0 cursor-pointer rounded-md bg-ink px-3.5 py-2 text-[13px] font-semibold text-white disabled:cursor-default disabled:opacity-40"
        >
          {busy ? "Fetching…" : "Judge"}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-muted">public repositories only</p>
    </form>
  );
}

/**
 * A dot and a word, and nothing at all when nothing is happening. Two models
 * answer here and they take different amounts of time, so this says which one
 * is working: Jev judging, or Luna writing the review.
 */
function Status({ review }: { review: ReviewState }) {
  const base = "flex items-center gap-2 text-[12px]";
  if (review.budgetSpent) {
    return (
      <span data-status="budget-spent" className={`${base} text-muted`}>
        budget spent
      </span>
    );
  }
  if (review.error) {
    return (
      <span data-status="error" className={`${base} text-bad`}>
        {review.error}
      </span>
    );
  }
  if (review.asking) {
    return (
      <span data-status="judging" className={`${base} text-muted`}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
        judging…
      </span>
    );
  }
  if (review.summary.running) {
    return (
      <span data-status="reviewing" className={`${base} text-muted`}>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        reviewing…
      </span>
    );
  }
  return null;
}
