"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { GROUPS, questionsFor } from "@/agent/lib/questions";
import { type FileJudgment, REVIEW_LIMITS, type ReviewFile } from "@/agent/lib/review";
import { diffStats, parsePatch } from "@/lib/diff";
import {
  fileSummaryStatus,
  fileVerdict,
  isWriting,
  pct,
  smellCount,
  smellLabel,
  type SummaryView,
  verdictConfidence,
  verdictScore,
} from "@/lib/display";
import { GroupIcon } from "@/lib/icons";
import { langLabel, langOf, splitPath } from "@/lib/language";
import { useChanges } from "@/lib/useChanges";
import { Editor, PatchEditor } from "./Editor";
import { Meter } from "./Meter";
import { ReviewNote } from "./ReviewNote";

/** The anchor the sidebar scrolls to. */
export function cardId(path: string): string {
  return `file-${encodeURIComponent(path)}`;
}

/**
 * The two-tone path used in the card header and the sidebar alike.
 *
 * The basename is the part that identifies the file, so it never truncates:
 * when the row is too narrow it is the directory that loses its left end.
 * `dir="rtl"` is what puts the overflow — and so the ellipsis — at the start
 * of the directory; the `bdi` keeps the path itself reading left to right.
 *
 * `stacked` is the sidebar's version, where the row is 16rem wide and the
 * paths of a real pull request are longer than that. The two parts go on two
 * lines instead of one: the directory muted above, truncated with an ordinary
 * end ellipsis, and the basename below in full — never cut, broken mid-word if
 * that is what it takes to fit. The RTL trick is not used there because it
 * clips the leading ellipsis and reorders the punctuation of a path like
 * `__tests__/`.
 */
export function FilePath({ path, stacked = false }: { path: string; stacked?: boolean }) {
  const [dir, base] = splitPath(path);
  if (stacked) {
    return (
      <span className="block min-w-0 font-mono text-[12px]" title={path}>
        {dir && <span className="block truncate text-muted">{dir}</span>}
        <span className="block break-all font-semibold text-ink">{base}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 font-mono text-[12px]" title={path}>
      {dir && (
        <span dir="rtl" className="min-w-0 truncate text-muted">
          <bdi>{dir}</bdi>
        </span>
      )}
      <span className="shrink-0 font-semibold text-ink">{base}</span>
    </span>
  );
}

export function LangChip({ path }: { path: string }) {
  return (
    <span className="shrink-0 rounded-full border border-line px-1.5 py-px text-[11px] text-muted">
      {langLabel(langOf(path))}
    </span>
  );
}

/** "7 smells" beside the verdict, in the header and in the sidebar alike. */
export function SmellCount({ count, className = "" }: { count: number; className?: string }) {
  return (
    <span data-smells={count} className={`text-[11px] ${count ? "text-bad" : "text-muted"} ${className}`}>
      {smellLabel(count)}
    </span>
  );
}

/**
 * One file of the review: its code across the card, Luna's paragraph about it,
 * and Jev's answers underneath. The code is the subject, so it gets the full
 * width — a diff beside a panel is two narrow columns and neither reads. Every
 * card keeps its own change tracking, so editing one file lights up that
 * file's rows and leaves the rest of the review alone.
 *
 * Only the questions that were asked about this file are shown: the Boy Scout
 * row is a question about a change, the test row a question about a test, and
 * a row nobody answered would read as a clean bill of health.
 *
 * Two things fold away. The chevron in the header collapses the card to its
 * header — a twenty-four file review is a long page, and the header alone is
 * the verdict, the smell count and the name. Inside, "Findings" folds the
 * meters away and leaves Luna's paragraph, which is the same judgment in words.
 */
export function FileCard({
  file,
  judgment,
  pending,
  failed,
  truncated,
  summary,
  collapsed,
  onToggle,
  onChange,
}: {
  file: ReviewFile;
  judgment: FileJudgment | undefined;
  pending: boolean;
  /** Jev was asked about this file twice and answered for neither. */
  failed: boolean;
  /** The paste was longer than one judgment reads, and this is the part that was. */
  truncated: boolean;
  /** Luna's review of the whole change, for the paragraph about this file. */
  summary: SummaryView;
  /** Only the header is on screen. */
  collapsed: boolean;
  onToggle: () => void;
  onChange: (next: string) => void;
}) {
  const answers = judgment?.answers;
  // Keyed on what actually decides the rows, so an edit does not hand the
  // change tracker a new question list on every keystroke.
  const questions = useMemo(() => questionsFor({ path: file.path, patch: file.patch }), [file.path, file.patch]);
  const changes = useChanges(answers ?? null, questions);
  const empty = !file.content.trim();
  const smells = smellCount(answers);
  const verdict = fileVerdict(verdictScore(answers), { empty, failed });
  const sure = verdictConfidence(answers);
  const stats = useMemo(() => (file.patch ? diffStats(parsePatch(file.content)) : null), [file.patch, file.content]);
  const lineCount = useMemo(() => file.content.split("\n").length, [file.content]);
  const [findingsOpen, setFindingsOpen] = useState(true);

  return (
    <article
      id={cardId(file.path)}
      data-file={file.path}
      data-collapsed={collapsed ? "1" : undefined}
      className="overflow-hidden rounded-md border border-line scroll-mt-4"
    >
      <header
        className={`flex flex-wrap items-center gap-x-3 gap-y-1 bg-surface px-3 py-2 ${collapsed ? "" : "border-b border-line"}`}
      >
        <button
          type="button"
          data-toggle="file"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${file.path}`}
          onClick={onToggle}
          className="-ml-1 shrink-0 cursor-pointer rounded p-0.5 text-muted hover:bg-track hover:text-ink"
        >
          {collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        </button>
        <FilePath path={file.path} />
        <LangChip path={file.path} />
        <span className="shrink-0 text-[12px] text-muted">
          {stats ? (
            <>
              <span className="text-ok">+{stats.added}</span> <span className="text-bad">&minus;{stats.removed}</span>
            </>
          ) : (
            `${lineCount} lines`
          )}
        </span>
        {truncated && (
          <span className="shrink-0 text-[11px] text-warn">
            Truncated to {REVIEW_LIMITS.maxCharsPerFile.toLocaleString()} characters
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {sure !== null && <span className="text-[11px] text-muted">{pct(sure)} sure</span>}
          {answers && <SmellCount count={smells} />}
          <span
            data-verdict={verdict.key}
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${verdict.className} ${
              verdict.key === "pending" ? "soft-pulse" : ""
            }`}
          >
            {verdict.label}
          </span>
        </span>
      </header>

      {!collapsed && (
        <>
          <div className="min-w-0">
            {file.patch ? (
              <PatchEditor path={file.path} content={file.content} onChange={onChange} />
            ) : (
              <Editor path={file.path} content={file.content} onChange={onChange} />
            )}
          </div>

          <section className="@container/card border-t border-line">
            <div className={`px-2 py-2 ${pending && !answers ? "soft-pulse" : ""}`}>
              <h3 className="mb-1.5 px-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">Review</h3>
              <div className="mb-2 px-1.5">
                <ReviewNote
                  status={fileSummaryStatus(summary, file.path)}
                  text={summary.files[file.path]}
                  model={summary.model}
                  writing={isWriting(summary, file.path)}
                />
              </div>
              <button
                type="button"
                data-toggle="findings"
                aria-expanded={findingsOpen}
                onClick={() => setFindingsOpen((open) => !open)}
                className="mb-1.5 ml-1.5 flex cursor-pointer items-center gap-1 rounded text-[11px] font-semibold tracking-wider text-muted uppercase hover:text-ink"
              >
                {findingsOpen ? (
                  <ChevronDown size={12} aria-hidden="true" />
                ) : (
                  <ChevronRight size={12} aria-hidden="true" />
                )}
                Findings
              </button>
              {findingsOpen && (
                <div className="grid grid-cols-1 items-start gap-x-5 @[800px]/card:grid-cols-2">
                  {GROUPS.map((group) => {
                    const rows = questions.filter((q) => q.group === group.id);
                    // A chapter with nothing to ask about this file is not a
                    // chapter with clean answers; it is not shown at all.
                    if (!rows.length) return null;
                    return (
                      <div key={group.id} className="@container/group mb-2 last:mb-0">
                        <div className="mb-1 flex flex-wrap items-center gap-x-2 border-b border-line px-1.5 pb-1">
                          <GroupIcon group={group.id} />
                          <h4 className="text-[11px] font-semibold tracking-wider text-muted uppercase">
                            {group.title}
                          </h4>
                          <span className="truncate text-[11px] text-muted/70">{group.blurb}</span>
                        </div>
                        {rows.map((q) => (
                          <Meter
                            key={q.id}
                            meta={q}
                            answer={answers?.[q.id]}
                            changed={changes.changed[q.id]}
                            delta={changes.delta[q.id]}
                          />
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </article>
  );
}
