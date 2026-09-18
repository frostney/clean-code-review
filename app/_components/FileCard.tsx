'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import { GROUPS, type Question, questionsFor } from '@/agent/lib/questions';
import {
  type FileJudgment,
  isProsePath,
  REVIEW_LIMITS,
  type ReviewFile,
} from '@/agent/lib/review';
import type { Answers } from '@/agent/lib/schema';
import { diffStats, parsePatch } from '@/lib/diff';
import {
  fileSummaryStatus,
  fileVerdict,
  isWriting,
  pct,
  type SummaryView,
  smellCount,
  smellLabel,
  type Verdict,
  verdictConfidence,
  verdictScore,
} from '@/lib/display';
import { GroupIcon } from '@/lib/icons';
import { langLabel, langOf, splitPath } from '@/lib/language';
import { type Changes, useChanges } from '@/lib/useChanges';

import { Editor, PatchEditor } from './Editor';
import { Meter } from './Meter';
import { ReviewNote } from './ReviewNote';

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
export function FilePath({
  path,
  stacked = false,
  className = '',
}: {
  path: string;
  stacked?: boolean;
  /** How the row this sits in wants it sized. */
  className?: string;
}) {
  const [dir, base] = splitPath(path);
  if (stacked) {
    return (
      <span
        className={`block min-w-0 font-mono text-[12px] ${className}`}
        title={path}
      >
        {dir ? <span className="block truncate text-muted">{dir}</span> : null}
        <span className="block break-all font-semibold text-ink">{base}</span>
      </span>
    );
  }
  return (
    <span
      className={`flex min-w-0 font-mono text-[12px] ${className}`}
      title={path}
    >
      {dir ? (
        <span className="min-w-0 truncate text-muted" dir="rtl">
          <bdi>{dir}</bdi>
        </span>
      ) : null}
      <span className="shrink-0 font-semibold text-ink">{base}</span>
    </span>
  );
}

export function LangChip({ path }: { path: string }) {
  return (
    <span className="shrink-0 rounded-full border border-line px-1.5 py-px text-tiny text-muted">
      {langLabel(langOf(path))}
    </span>
  );
}

/**
 * What a prose file wears where a judged file wears its verdict. Grey and
 * unbold enough not to read as an answer, because it is not one: a README is
 * on the page for context, and none of the questions is asked about it.
 */
export function ProseChip({ className = '' }: { className?: string }) {
  return (
    <span
      className={`shrink-0 rounded-full bg-track px-2 py-0.5 text-tiny text-muted ${className}`}
      data-prose="1"
    >
      prose
    </span>
  );
}

/** "7 smells" beside the verdict, in the header and in the sidebar alike. */
export function SmellCount({
  count,
  className = '',
}: {
  count: number;
  className?: string;
}) {
  return (
    <span
      className={`text-tiny ${count ? 'text-bad' : 'text-muted'} ${className}`}
      data-smells={count}
    >
      {smellLabel(count)}
    </span>
  );
}

/**
 * The card's one always-visible line: the fold, the path, the language, how big
 * the change is, and the verdict. It is the whole card while the card is
 * folded, which is why it carries the smell count and the badge.
 */
function CardHeader({
  answers,
  collapsed,
  lineCount,
  onToggle,
  path,
  smells,
  stats,
  sure,
  truncated,
  verdict,
}: {
  answers: Answers | undefined;
  collapsed: boolean;
  lineCount: number;
  onToggle: () => void;
  path: string;
  smells: number;
  /** How many lines the change adds and removes, when the file is a diff. */
  stats: { added: number; removed: number } | null;
  /** How sure Jev is of the verdict, when it said. */
  sure: number | null;
  truncated: boolean;
  /** Null for a prose file: nothing judged it, so it wears a chip instead. */
  verdict: Verdict | null;
}) {
  return (
    <header
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 bg-surface px-3 py-2 ${collapsed ? '' : 'border-b border-line'}`}
    >
      <button
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${path}`}
        className="-my-1.5 -ml-2 flex min-h-10 min-w-10 shrink-0 cursor-pointer items-center justify-center rounded text-muted hover:bg-track hover:text-ink lg:my-0 lg:-ml-1 lg:min-h-0 lg:min-w-0 lg:p-0.5"
        data-toggle="file"
        onClick={onToggle}
        type="button"
      >
        {collapsed ? (
          <ChevronRight aria-hidden="true" size={14} />
        ) : (
          <ChevronDown aria-hidden="true" size={14} />
        )}
      </button>
      <FilePath
        className="min-w-0 flex-1 basis-40 lg:flex-initial lg:basis-auto"
        path={path}
      />
      <LangChip path={path} />
      <span className="shrink-0 text-[12px] text-muted">
        {stats ? (
          <>
            <span className="text-ok">+{stats.added}</span>{' '}
            <span className="text-bad">&minus;{stats.removed}</span>
          </>
        ) : (
          `${lineCount} lines`
        )}
      </span>
      {truncated ? (
        <span className="shrink-0 text-tiny text-warn">
          Truncated to {REVIEW_LIMITS.maxCharsPerFile.toLocaleString()}{' '}
          characters
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {verdict === null ? (
          <ProseChip />
        ) : (
          <>
            {sure === null ? null : (
              <span className="text-tiny text-muted">{pct(sure)} sure</span>
            )}
            {answers ? <SmellCount count={smells} /> : null}
            <span
              className={`rounded-full px-2 py-0.5 text-tiny font-semibold ${verdict.className} ${
                verdict.key === 'pending' ? 'soft-pulse' : ''
              }`}
              data-verdict={verdict.key}
            >
              {verdict.label}
            </span>
          </>
        )}
      </span>
    </header>
  );
}

/**
 * The judged half of a card: Luna's paragraph about this file, and Jev's
 * answers under a fold. Only a code file has one — prose is read, not judged,
 * so a prose card ends at the text of the file.
 */
function Judgment({
  answers,
  changes,
  findingsOpen,
  onToggleFindings,
  path,
  pending,
  questions,
  summary,
}: {
  answers: Answers | undefined;
  changes: Changes;
  /** The meters are unfolded; folded, Luna's paragraph stands alone. */
  findingsOpen: boolean;
  onToggleFindings: () => void;
  path: string;
  pending: boolean;
  /** The questions that were asked about this file, in book order. */
  questions: readonly Question[];
  summary: SummaryView;
}) {
  return (
    <section className="@container/card border-t border-line">
      <div className={`px-2 py-2 ${pending && !answers ? 'soft-pulse' : ''}`}>
        <h3 className="mb-1.5 px-1.5 text-tiny font-semibold tracking-wider text-muted uppercase">
          Review
        </h3>
        <div className="mb-2 px-1.5">
          <ReviewNote
            incomplete={summary.incomplete[path] === true}
            model={summary.model}
            status={fileSummaryStatus(summary, path)}
            text={summary.files[path]}
            writing={isWriting(summary, path)}
          />
        </div>
        <button
          aria-expanded={findingsOpen}
          className="mb-0.5 ml-1.5 flex min-h-10 cursor-pointer items-center gap-1 rounded pr-2 text-tiny font-semibold tracking-wider text-muted uppercase hover:text-ink lg:mb-1.5 lg:min-h-0 lg:pr-0"
          data-toggle="findings"
          onClick={onToggleFindings}
          type="button"
        >
          {findingsOpen ? (
            <ChevronDown aria-hidden="true" size={12} />
          ) : (
            <ChevronRight aria-hidden="true" size={12} />
          )}
          Findings
        </button>
        {findingsOpen ? (
          <div className="grid grid-cols-1 items-start gap-x-5 @[800px]/card:grid-cols-2">
            {GROUPS.map((group) => (
              <FindingGroup
                answers={answers}
                changes={changes}
                group={group}
                key={group.id}
                questions={questions}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One chapter of the book, with the rows that were asked about this file. A
 * chapter with nothing to ask is not a chapter with clean answers, so it is
 * not shown at all.
 */
function FindingGroup({
  answers,
  changes,
  group,
  questions,
}: {
  answers: Answers | undefined;
  changes: Changes;
  group: (typeof GROUPS)[number];
  questions: readonly Question[];
}) {
  const rows = questions.filter((q) => q.group === group.id);
  if (!rows.length) {
    return null;
  }
  return (
    <div className="@container/group mb-2 last:mb-0">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 border-b border-line px-1.5 pb-1">
        <GroupIcon group={group.id} />
        <h4 className="text-tiny font-semibold tracking-wider text-muted uppercase">
          {group.title}
        </h4>
        <span className="hidden truncate text-tiny text-muted/70 @[320px]/group:inline">
          {group.blurb}
        </span>
      </div>
      {rows.map((q) => (
        <Meter
          answer={answers?.[q.id]}
          changed={changes.changed[q.id]}
          delta={changes.delta[q.id]}
          key={q.id}
          meta={q}
        />
      ))}
    </div>
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
 *
 * A prose file is the one card that is none of this. Clean Code is a book
 * about code, so a README is read and not judged: no verdict, no review, no
 * meters, and the text is shown rather than edited, since editing it would
 * re-judge nothing.
 */
export function FileCard({
  file,
  judgment,
  pending,
  failed,
  paused,
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
  /** The site's model budget refused this file's turn; nothing is coming until it resets. */
  paused: boolean;
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
  // Documentation, not code: shown with the review, never sent to either
  // model. There is no verdict, no finding and nothing to edit, so the card
  // below stops at the text of the file.
  const prose = isProsePath(file.path);
  // Keyed on what actually decides the rows, so an edit does not hand the
  // change tracker a new question list on every keystroke.
  const questions = useMemo(
    () => questionsFor({ patch: file.patch, path: file.path }),
    [file.path, file.patch],
  );
  const changes = useChanges(answers ?? null, questions);
  const empty = !file.content.trim();
  const smells = prose ? 0 : smellCount(answers);
  const verdict = prose
    ? null
    : fileVerdict(verdictScore(answers), { empty, failed, paused });
  const sure = prose ? null : verdictConfidence(answers);
  const stats = useMemo(
    () => (file.patch ? diffStats(parsePatch(file.content)) : null),
    [file.patch, file.content],
  );
  const lineCount = useMemo(
    () => file.content.split('\n').length,
    [file.content],
  );
  const [findingsOpen, setFindingsOpen] = useState(true);

  return (
    <article
      className="overflow-hidden rounded-md border border-line scroll-mt-4"
      data-collapsed={collapsed ? '1' : undefined}
      data-file={file.path}
      id={cardId(file.path)}
    >
      <CardHeader
        answers={answers}
        collapsed={collapsed}
        lineCount={lineCount}
        onToggle={onToggle}
        path={file.path}
        smells={smells}
        stats={stats}
        sure={sure}
        truncated={truncated}
        verdict={verdict}
      />

      {!collapsed && (
        <>
          <div className="min-w-0">
            {file.patch ? (
              <PatchEditor
                content={file.content}
                onChange={prose ? null : onChange}
                path={file.path}
              />
            ) : (
              <Editor
                content={file.content}
                onChange={prose ? null : onChange}
                path={file.path}
              />
            )}
          </div>

          {prose ? null : (
            <Judgment
              answers={answers}
              changes={changes}
              findingsOpen={findingsOpen}
              onToggleFindings={() => setFindingsOpen((open) => !open)}
              path={file.path}
              pending={pending}
              questions={questions}
              summary={summary}
            />
          )}
        </>
      )}
    </article>
  );
}
