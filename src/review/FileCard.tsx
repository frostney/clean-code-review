'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  GROUPS,
  type Question,
  questionsFor,
} from '@/agent/lib/judging/questions';
import type { Answers } from '@/agent/lib/judging/schema';
import {
  type FileJudgment,
  isProsePath,
  REVIEW_LIMITS,
  type ReviewFile,
} from '@/agent/lib/review/review';

import { diffStats, parsePatch } from './diff';
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
} from './display';
import { Editor, PatchEditor } from './Editor';
import { GroupIcon } from './icons';
import { langLabel, langOf, splitPath } from './language';
import { Meter } from './Meter';
import { PendingDot } from './PendingDot';
import { ReviewNote } from './ReviewNote';
import { useOnScreen, type WatchCard } from './useCardWindow';
import { type Changes, useChanges } from './useChanges';

/**
 * By index, not path: Speed Insights reports the nearest id, and a path would
 * reveal which repository was being read.
 */
export function cardId(index: number): string {
  return `file-${index}`;
}

/**
 * The basename never truncates; the directory loses its left end instead.
 * `dir="rtl"` puts the ellipsis at the start, and `bdi` keeps the path itself
 * left to right.
 *
 * `stacked` (the 16rem sidebar) puts the directory above the basename instead.
 * The RTL trick is not used there: it clips the leading ellipsis and reorders
 * the punctuation of paths like `__tests__/`.
 */
export function FilePath({
  path,
  stacked = false,
  className = '',
}: {
  path: string;
  stacked?: boolean;
  className?: string;
}) {
  const [dir, base] = splitPath(path);
  if (stacked) {
    return (
      <span
        className={`block min-w-0 font-mono text-xs ${className}`}
        title={path}
      >
        {dir ? <span className="block truncate text-muted">{dir}</span> : null}
        <span className="block break-all font-semibold text-ink">{base}</span>
      </span>
    );
  }
  return (
    <span
      className={`flex min-w-0 font-mono text-xs ${className}`}
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
    <span className="shrink-0 rounded-full border border-line px-1.5 py-px text-xs text-muted">
      {langLabel(langOf(path))}
    </span>
  );
}

/** Muted so it does not read as a verdict: prose files are never judged. */
export function ProseChip({ className = '' }: { className?: string }) {
  return (
    <span
      className={`shrink-0 rounded-full bg-track px-2 py-0.5 text-xs text-muted ${className}`}
      data-prose="1"
    >
      prose
    </span>
  );
}

export function SmellCount({
  count,
  className = '',
}: {
  count: number;
  className?: string;
}) {
  return (
    <span
      className={`text-xs ${count ? 'text-bad' : 'text-muted'} ${className}`}
      data-smells={count}
    >
      {smellLabel(count)}
    </span>
  );
}

function CardHeader({
  answers,
  collapsed,
  lineCount,
  onToggle,
  path,
  smells,
  stats,
  confidence,
  truncated,
  verdict,
}: {
  answers: Answers | undefined;
  collapsed: boolean;
  lineCount: number;
  onToggle: () => void;
  path: string;
  smells: number;
  /** Null unless the file is a diff. */
  stats: { added: number; removed: number } | null;
  confidence: number | null;
  truncated: boolean;
  /** Null for a prose file. */
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
      <span className="shrink-0 text-xs text-muted">
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
        <span className="shrink-0 text-xs text-warn">
          Truncated to {REVIEW_LIMITS.maxCharsPerFile.toLocaleString()}{' '}
          characters
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {verdict === null ? (
          <ProseChip />
        ) : (
          <>
            {confidence === null ? null : (
              <span className="text-xs text-muted">{pct(confidence)} sure</span>
            )}
            {answers ? <SmellCount count={smells} /> : null}
            <span
              className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${verdict.className}`}
              data-verdict={verdict.key}
            >
              {verdict.key === 'pending' ? <PendingDot /> : null}
              {verdict.label}
            </span>
          </>
        )}
      </span>
    </header>
  );
}

function Judgment({
  answers,
  changes,
  findingsOpen,
  onToggleFindings,
  path,
  questions,
  summary,
}: {
  answers: Answers | undefined;
  changes: Changes;
  findingsOpen: boolean;
  onToggleFindings: () => void;
  path: string;
  questions: readonly Question[];
  summary: SummaryView;
}) {
  return (
    <section className="@container/card border-t border-line">
      <div className="px-2 py-2">
        <h3 className="mb-1.5 px-1.5 text-xs font-semibold tracking-wider text-muted uppercase">
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
          className="mb-0.5 ml-1.5 flex min-h-10 cursor-pointer items-center gap-1 rounded pr-2 text-xs font-semibold tracking-wider text-muted uppercase hover:text-ink lg:mb-1.5 lg:min-h-0 lg:pr-0"
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

// A group with no questions is hidden, not shown as clean.
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
        <h4 className="text-xs font-semibold tracking-wider text-muted uppercase">
          {group.title}
        </h4>
        <span className="hidden truncate text-xs text-subtle @[320px]/group:inline">
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

/** Must match `.code-line` and the `py-2` around a file's rows. */
const CODE_ROW_PX = 20;
const CODE_PAD_PX = 16;

/**
 * `content-visibility: auto` for drawn code: laying out every row of a large
 * pull request was most of the first frame. The reserved height is exact
 * because every row is one line of fixed height, so nothing moves.
 *
 * Editable files only: their horizontal scrollbar is inside the textarea over
 * the rows. A prose file scrolls itself, and a long line adds a scrollbar
 * height the rows cannot predict.
 *
 * The text stays in the document for find-in-page and screen readers.
 */
function codeSpace(
  lines: number,
  editable: boolean,
): CSSProperties | undefined {
  if (!editable) {
    return;
  }
  return {
    containIntrinsicBlockSize: `auto ${lines * CODE_ROW_PX + CODE_PAD_PX}px`,
    contentVisibility: 'auto',
  };
}

/**
 * The code's height is exact; the review and meters are estimated in
 * `globals.css`, next to the layout they depend on.
 */
function BodySpace({
  groups,
  judged,
  lines,
  rows,
}: {
  groups: number;
  judged: boolean;
  lines: number;
  rows: number;
}) {
  const style = {
    '--space-groups': groups,
    '--space-judged': judged ? 1 : 0,
    '--space-lines': lines,
    '--space-rows': rows,
  } as CSSProperties;
  // Not a scroll anchor: it is about to be replaced.
  return (
    <div
      aria-hidden="true"
      className="@container/space [overflow-anchor:none]"
      data-space="1"
    >
      <div className="card-space" style={style} />
    </div>
  );
}

/**
 * Code takes the full width: a diff beside a panel is two narrow columns and
 * neither reads. Only questions asked about this file are shown; an
 * unanswered row would read as a clean bill of health.
 *
 * Prose files (e.g. a README) are shown read-only, with no verdict, review or
 * meters: editing them would re-judge nothing.
 */
export function FileCard({
  file,
  index,
  judgment,
  failed,
  paused,
  stalled,
  truncated,
  summary,
  collapsed,
  onToggle,
  onChange,
  deferred,
  watch,
}: {
  file: ReviewFile;
  index: number;
  judgment: FileJudgment | undefined;
  /** Unanswered twice; given up on. */
  failed: boolean;
  /** Refused by the site's model budget until it resets. */
  paused: boolean;
  /** Let go by a failed turn until Retry or an edit. */
  stalled: boolean;
  truncated: boolean;
  summary: SummaryView;
  collapsed: boolean;
  onToggle: () => void;
  onChange: (next: string) => void;
  /** Header plus a placeholder until the reader comes near. */
  deferred: boolean;
  watch: WatchCard;
}) {
  const answers = judgment?.answers;
  // Never sent to either model.
  const prose = isProsePath(file.path);
  // Not keyed on content, so typing does not hand useChanges a new list.
  const questions = useMemo(
    () => questionsFor({ patch: file.patch, path: file.path }),
    [file.path, file.patch],
  );
  const changes = useChanges(answers ?? null, questions);
  const empty = !file.content.trim();
  const smells = prose ? 0 : smellCount(answers);
  const verdict = prose
    ? null
    : fileVerdict(verdictScore(answers), {
        empty,
        failed,
        paused,
        stalled,
      });
  const confidence = prose ? null : verdictConfidence(answers);
  const stats = useMemo(
    () => (file.patch ? diffStats(parsePatch(file.content)) : null),
    [file.patch, file.content],
  );
  const lineCount = useMemo(
    () => file.content.split('\n').length,
    [file.content],
  );
  const [findingsOpen, setFindingsOpen] = useState(true);
  const articleRef = useRef<HTMLElement>(null);
  const onScreen = useOnScreen(articleRef);

  useEffect(() => {
    const article = articleRef.current;
    return deferred && article ? watch(article, file.path) : undefined;
  }, [deferred, watch, file.path]);

  const groups = useMemo(
    () => GROUPS.filter((g) => questions.some((q) => q.group === g.id)).length,
    [questions],
  );

  return (
    <article
      className="overflow-hidden rounded-md border border-line scroll-mt-4"
      data-collapsed={collapsed ? '1' : undefined}
      data-deferred={deferred ? '1' : undefined}
      data-file={file.path}
      id={cardId(index)}
      ref={articleRef}
    >
      <CardHeader
        answers={answers}
        collapsed={collapsed}
        confidence={confidence}
        lineCount={lineCount}
        onToggle={onToggle}
        path={file.path}
        smells={smells}
        stats={stats}
        truncated={truncated}
        verdict={verdict}
      />

      {!collapsed && deferred ? (
        <BodySpace
          groups={groups}
          judged={!prose}
          lines={lineCount}
          rows={questions.length}
        />
      ) : null}
      {!collapsed && !deferred && (
        <>
          <div className="min-w-0" style={codeSpace(lineCount, !prose)}>
            {file.patch ? (
              <PatchEditor
                content={file.content}
                onChange={prose ? null : onChange}
                onScreen={onScreen}
                path={file.path}
              />
            ) : (
              <Editor
                content={file.content}
                onChange={prose ? null : onChange}
                onScreen={onScreen}
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
              questions={questions}
              summary={summary}
            />
          )}
        </>
      )}
    </article>
  );
}
