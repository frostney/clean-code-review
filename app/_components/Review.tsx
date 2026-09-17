"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { filesFromPatch } from "@/agent/lib/patch";
import { type Preset, PRESETS } from "@/agent/lib/presets";
import { partitionJudgeable, REVIEW_LIMITS, type ReviewFile, type SkipReason } from "@/agent/lib/review";
import { selectReviewFiles } from "@/agent/lib/select";
import { SESSION_BUDGET_USD } from "@/lib/budget";
import { splitPatchHeader, withPatchHeader } from "@/lib/diff";
import { isWriting, overallSummaryStatus } from "@/lib/display";
import { filesFromPaste, uniquePaths } from "@/lib/paste";
import { type PullRequestContext, useReview } from "@/lib/useReview";
import { cardId, FileCard } from "./FileCard";
import { FileList } from "./FileList";
import { Notice } from "./Notice";
import { Paste } from "./Paste";
import { ReviewHeader } from "./ReviewHeader";
import { ReviewNote } from "./ReviewNote";

/** Only rendered when the deploy knows where its own source lives. */
const SOURCE_URL = process.env.NEXT_PUBLIC_SOURCE_URL;

interface OpenReview {
  /** Changes whenever a different set of files is opened, never on an edit. */
  id: string;
  /** The example this came from, for the chip that stays lit. */
  preset: string | null;
  /** Set when these files came from a GitHub pull request. */
  pr: PullRequestContext | null;
  /** A patch file holds only its hunks here; its headers wait in `headers`. */
  files: ReviewFile[];
  /** Path → the `diff --git`/`index`/`---`/`+++` run lifted off that patch. */
  headers: Record<string, string>;
  /** How many files the paste or preset had before the cap, for the notice. */
  totalFiles: number;
  /** Paths whose text was cut to what one judgment reads. */
  truncated: Record<string, true>;
  /** Files that are not code, and why. Never rendered, always reported. */
  skipped: { path: string; reason: SkipReason }[];
  /**
   * Files a pull request had that never reached `skipped` because the diff
   * splitter dropped them first — binaries with no hunk, generated paths,
   * pure deletions. Counted against what GitHub said the PR touches.
   */
  skippedCount: number;
  /** Files a pull request had beyond the per-turn cap, for the notice. */
  dropped: number;
}

/**
 * What a review actually shows. Only what will be judged makes it onto the
 * page: unique paths, because every key, edit and judgment is by path; at most
 * `maxFiles`, because a turn judges no more than that; and no more characters
 * per file than one is judged on, so the code on screen is the code Jev read.
 *
 * A patch file is split here as well: the headers are the file's name in
 * machine and are not on screen, so they are not edited either — they wait in
 * `headers` and go back on the moment the file is sent.
 *
 * Images, binaries and generated files never become a card. A judgment about a
 * PNG or a lockfile is noise, and the agent drops them on its side too — so
 * every way in goes through the same partition, and what it left out is said
 * out loud rather than silently missing.
 */
function opened(files: readonly ReviewFile[]): Omit<OpenReview, "id" | "preset" | "pr" | "dropped" | "skippedCount"> {
  const { judgeable, skipped } = partitionJudgeable(files);
  const unique = uniquePaths(judgeable);
  const truncated: Record<string, true> = {};
  const headers: Record<string, string> = {};
  const kept = unique.slice(0, REVIEW_LIMITS.maxFiles).map((file) => {
    let shown = file;
    if (shown.content.length > REVIEW_LIMITS.maxCharsPerFile) {
      truncated[shown.path] = true;
      shown = { ...shown, content: shown.content.slice(0, REVIEW_LIMITS.maxCharsPerFile) };
    }
    if (!shown.patch) return shown;
    const { header, body } = splitPatchHeader(shown.content);
    if (header) headers[shown.path] = header;
    return { ...shown, content: body };
  });
  return { files: kept, headers, totalFiles: unique.length, truncated, skipped };
}

function fromPreset(preset: Preset, nonce: number): OpenReview {
  return { id: `${preset.label}#${nonce}`, preset: preset.label, pr: null, dropped: 0, skippedCount: 0, ...opened(preset.files) };
}

/**
 * "Skipped 3 images or binaries and 2 generated files" — what never became a
 * card, in words. A pull request's diff is already filtered by the agent's own
 * splitter, so those files arrive as a bare count with no reason attached;
 * they are still worth saying, just less precisely.
 */
function skippedText(skipped: readonly { reason: SkipReason }[], count: number): string | null {
  const binary = skipped.filter((s) => s.reason === "binary").length;
  const generated = skipped.filter((s) => s.reason === "generated").length;
  const parts: string[] = [];
  if (binary) parts.push(`${binary} ${binary === 1 ? "image or binary" : "images or binaries"}`);
  if (generated) parts.push(`${generated} generated ${generated === 1 ? "file" : "files"}`);
  const unattributed = Math.max(0, count - skipped.length);
  if (unattributed) parts.push(`${unattributed} generated or non-code ${unattributed === 1 ? "file" : "files"}`);
  return parts.length ? `Skipped ${parts.join(" and ")}` : null;
}

export function Review() {
  // Opens on the pull request, so the page is already a review before anyone
  // touches it.
  const [review, setReview] = useState<OpenReview>(() => fromPreset(PRESETS[0], 0));
  const [pasting, setPasting] = useState(false);
  /** Where focus goes when the paste dialog closes. */
  const pasteButtonRef = useRef<HTMLButtonElement>(null);
  // A counter, not state: two reviews opened before the next render would both
  // read the same value and share an id, and an id is what tells the hook a
  // different review is on screen.
  const nonceRef = useRef(0);
  const [fetching, setFetching] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  /** Paths folded to their header. Per review: another example starts open. */
  const [collapsed, setCollapsed] = useState<Record<string, true>>({});
  /** The card the sidebar was last clicked for, scrolled to once it is open. */
  const [revealed, setRevealed] = useState<{ path: string; at: number } | null>(null);

  // What goes on the wire: the files as shown, with every patch back under the
  // headers it was split from, so the agent's parser and its after-image read a
  // section git could have written. An emptied file stays empty — its headers
  // alone are not a question, and the card already says "Nothing to judge".
  const sent = useMemo(
    () =>
      review.files.map((file) => {
        const header = review.headers[file.path];
        if (!file.patch || !header || !file.content.trim()) return file;
        return { ...file, content: withPatchHeader(header, file.content) };
      }),
    [review.files, review.headers],
  );

  const judge = useReview(review.id, sent, review.pr ?? undefined);

  const lineCount = useMemo(
    () => review.files.reduce((total, file) => total + file.content.split("\n").length, 0),
    [review.files],
  );

  const allCollapsed = review.files.length > 0 && review.files.every((file) => collapsed[file.path]);

  // Folding is about this review's files; another example is a fresh page.
  useEffect(() => {
    setCollapsed({});
  }, [review.id]);

  // A card is scrolled to after the render that opened it, not before: a
  // folded card is a header tall, and its top is not where it will be.
  useLayoutEffect(() => {
    if (!revealed) return;
    document.getElementById(cardId(revealed.path))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [revealed]);

  /** The sidebar's click: unfold that file and bring it into view. */
  function reveal(path: string) {
    setCollapsed((current) => {
      if (!current[path]) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
    setRevealed({ path, at: Date.now() });
  }

  function open(preset: Preset) {
    setReview(fromPreset(preset, (nonceRef.current += 1)));
    setPasting(false);
    setPrError(null);
  }

  function judgePasted(text: string) {
    const files = filesFromPaste(text);
    if (!files.length) return;
    setReview({ id: `paste#${(nonceRef.current += 1)}`, preset: null, pr: null, dropped: 0, skippedCount: 0, ...opened(files) });
    setPasting(false);
    setPrError(null);
  }

  /**
   * A pull request is a paste the page fetches for you. The diff comes from
   * the server (GitHub sends no CORS headers for one), is split per file the
   * same way a pasted diff is, and then loses whatever is not worth a
   * judgment — lockfiles, bundles, images — before the review opens.
   */
  async function openPullRequest(url: string) {
    setFetching(true);
    setPrError(null);
    try {
      const response = await fetch(`/api/github-pr?url=${encodeURIComponent(url)}`);
      const payload = (await response.json()) as {
        url?: string;
        title?: string;
        body?: string;
        diff?: string;
        changedFiles?: number;
        error?: string;
      };
      if (!response.ok || !payload.diff) {
        setPrError(payload.error ?? `Could not fetch that pull request (HTTP ${response.status}).`);
        return;
      }
      const judgeable = filesFromPatch(payload.diff);
      const { kept, skipped, dropped } = selectReviewFiles(judgeable);
      if (!kept.length) {
        setPrError("That pull request has no code files to judge.");
        return;
      }
      const review = opened(kept);
      setReview({
        id: `pr#${(nonceRef.current += 1)}`,
        preset: null,
        pr: { title: payload.title ?? url, body: payload.body ?? "", url: payload.url ?? url },
        dropped: dropped.length,
        // What GitHub counted as touched, minus what survived the splitter.
        skippedCount: Math.max(0, (payload.changedFiles ?? 0) - judgeable.length),
        ...review,
        // The diff splitter drops what is not code before this point, so the
        // pull request's own skip list and the partition's are the same list
        // seen twice; count each path once.
        skipped: [
          ...review.skipped,
          ...skipped
            .filter((path) => !review.skipped.some((s) => s.path === path))
            .map((path) => ({ path, reason: "generated" as const })),
        ],
      });
      setPasting(false);
    } catch (err) {
      setPrError(err instanceof Error ? err.message : "Could not fetch that pull request.");
    } finally {
      setFetching(false);
    }
  }

  /** An edit replaces that file's content and nothing else in the review. */
  function edit(path: string, content: string) {
    setReview((current) => ({
      ...current,
      files: current.files.map((file) => (file.path === path ? { ...file, content } : file)),
    }));
  }

  const selectionNotice = [
    skippedText(review.skipped, Math.max(review.skipped.length, review.skippedCount)),
    review.dropped
      ? `${review.dropped} more ${review.dropped === 1 ? "file" : "files"} not judged (largest ${REVIEW_LIMITS.maxFiles} kept)`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-5">
      <ReviewHeader
        review={judge}
        presets={PRESETS}
        activePreset={review.preset}
        onPick={open}
        onPaste={() => setPasting(true)}
        pasteButtonRef={pasteButtonRef}
        onOpenPullRequest={openPullRequest}
        fetching={fetching}
        pr={review.pr}
        fileCount={review.files.length}
        lineCount={lineCount}
      />

      <div className="mb-4">
        <ReviewNote
          tone="overall"
          status={overallSummaryStatus(judge.summary)}
          text={judge.summary.overall}
          decision={judge.summary.decision}
          error={judge.summary.error}
          model={judge.summary.model}
          writing={isWriting(judge.summary, "overall")}
        />
      </div>

      {judge.budgetSpent && <BudgetSpent spentUsd={judge.spentUsd} />}
      {prError && <Notice data-pr="error">{prError}</Notice>}
      {selectionNotice && <Notice data-files="skipped">{selectionNotice}</Notice>}
      {review.totalFiles > review.files.length && (
        <Notice data-files="capped">
          Showing the first {review.files.length} of {review.totalFiles} files. A review is judged in one turn, and one
          turn carries {REVIEW_LIMITS.maxFiles}.
        </Notice>
      )}
      <Paste
        open={pasting}
        onJudge={judgePasted}
        onClose={() => {
          setPasting(false);
          // A `<dialog>` hands focus back on its own, but only while it stays
          // mounted and focused; saying so is what makes it certain.
          pasteButtonRef.current?.focus();
        }}
      />

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <FileList
          files={review.files}
          judgments={judge.judgments}
          failed={judge.failed}
          allCollapsed={allCollapsed}
          onToggleAll={() =>
            setCollapsed(allCollapsed ? {} : Object.fromEntries(review.files.map((f) => [f.path, true as const])))
          }
          onSelect={reveal}
        />
        <div className="flex min-w-0 flex-col gap-4">
          {review.files.map((file) => (
            <FileCard
              key={file.path}
              file={file}
              judgment={judge.judgments[file.path]}
              pending={!!judge.pending[file.path]}
              failed={!!judge.failed[file.path]}
              truncated={!!review.truncated[file.path]}
              summary={judge.summary}
              collapsed={!!collapsed[file.path]}
              onToggle={() =>
                setCollapsed((current) => {
                  const next = { ...current };
                  if (next[file.path]) delete next[file.path];
                  else next[file.path] = true;
                  return next;
                })
              }
              onChange={(content) => edit(file.path, content)}
            />
          ))}
        </div>
      </div>

      <footer className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
        {judge.usage && (
          <span>
            {judge.usage.inputTokens}&rarr;{judge.usage.outputTokens} tokens (last turn)
          </span>
        )}
        <span data-spent-usd={judge.spentUsd.toFixed(4)}>
          ${judge.spentUsd.toFixed(4)} of ${SESSION_BUDGET_USD.toFixed(2)} session budget
        </span>
        <a href="https://vercel.com/ai-gateway/models/jev" target="_blank" rel="noreferrer" className="underline hover:text-ink">
          judged by Jev
        </a>
        <a href="https://eve.dev" target="_blank" rel="noreferrer" className="underline hover:text-ink">
          built with eve
        </a>
        {SOURCE_URL && (
          <a href={SOURCE_URL} target="_blank" rel="noreferrer" className="underline hover:text-ink">
            view source
          </a>
        )}
      </footer>
    </div>
  );
}

/**
 * Each tab is one durable eve session, capped at a fixed dollar amount in
 * agent.ts. This is what running into that cap looks like: eve parked the turn
 * asking whether to keep spending, and a demo has nobody to ask.
 */
function BudgetSpent({ spentUsd }: { spentUsd: number }) {
  return (
    <Notice data-budget="spent">
      <strong className="font-semibold">This session&rsquo;s budget is spent.</strong> ${spentUsd.toFixed(2)} of $
      {SESSION_BUDGET_USD.toFixed(2)} went on judging code in this tab. The meters are frozen on the last answers —
      reload for a fresh session.
    </Notice>
  );
}
