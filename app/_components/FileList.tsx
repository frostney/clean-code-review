"use client";

import type { FileJudgment, ReviewFile } from "@/agent/lib/review";
import { fileVerdict, smellCount, verdictFill, verdictScore } from "@/lib/display";
import { FilePath, LangChip, SmellCount } from "./FileCard";

/**
 * The files in this review, the way a review tool lists them: a row per file,
 * its verdict in one word, and a hairline of a bar so the shape of the review
 * is readable before a single card is. A row is also how a folded card is
 * reopened: clicking one expands that file and scrolls the page to it.
 */
export function FileList({
  files,
  judgments,
  failed,
  allCollapsed,
  onToggleAll,
  onSelect,
}: {
  files: readonly ReviewFile[];
  judgments: Record<string, FileJudgment>;
  /** Paths Jev was asked about twice and answered for neither. */
  failed: Record<string, true>;
  /** Every card in the review is folded to its header. */
  allCollapsed: boolean;
  onToggleAll: () => void;
  /** Expand that file's card and bring it into view. */
  onSelect: (path: string) => void;
}) {
  return (
    <nav aria-label="Files in this review" className="min-w-0 lg:sticky lg:top-4">
      <div className="mb-2 flex items-center gap-2 px-1">
        <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">Files</h2>
        <button
          type="button"
          data-toggle="all"
          onClick={onToggleAll}
          className="ml-auto shrink-0 cursor-pointer text-[11px] text-muted hover:text-ink"
        >
          {allCollapsed ? "Expand all" : "Collapse all"}
        </button>
      </div>
      <ul className="flex gap-2 overflow-x-auto pb-2 lg:block lg:gap-0 lg:overflow-visible lg:pb-0">
        {files.map((file) => {
          const answers = judgments[file.path]?.answers;
          const score = verdictScore(answers);
          const verdict = fileVerdict(score, { empty: !file.content.trim(), failed: !!failed[file.path] });
          return (
            <li key={file.path} className="shrink-0 lg:shrink">
              <button
                type="button"
                data-file={file.path}
                data-verdict={verdict.key}
                onClick={() => onSelect(file.path)}
                className="w-56 cursor-pointer rounded-md px-2 py-1.5 text-left hover:bg-surface lg:w-full"
              >
                <FilePath path={file.path} stacked />
                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                  <LangChip path={file.path} />
                  <span className={`text-[11px] text-muted ${verdict.key === "pending" ? "soft-pulse" : ""}`}>
                    {verdict.label}
                  </span>
                  {answers && (
                    <>
                      <span className="text-[11px] text-muted/60">·</span>
                      <SmellCount count={smellCount(answers)} />
                    </>
                  )}
                </span>
                <span className="mt-1 block h-1 w-full rounded-full bg-track">
                  <span
                    className="block h-full rounded-full bg-ink"
                    style={{ width: `${verdictFill(score) * 100}%`, transition: "width 300ms" }}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
