"use client";

import { type RefObject, useRef, useState } from "react";
import type { Preset } from "@/agent/lib/presets";
import { SESSION_BUDGET_USD } from "@/lib/budget";
import type { PullRequestContext, ReviewState } from "@/lib/useReview";
import { PullRequestBody } from "./PullRequestBody";

/**
 * The top of a pull request: what is being reviewed, and how it got here.
 *
 * A pull request is the way in, so it is the first thing on the page: one
 * field with `github.com/` already typed into it. The examples and the paste
 * box sit below as the secondary way in, because choosing what to review is
 * part of the same header, not a sidebar. The conclusion is not here — the
 * verdict, the smell count and the status ride on the overall review card,
 * beside the decision they belong with.
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
  const cached = review.cached || review.summary.cached;

  return (
    <header className="mb-4">
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
