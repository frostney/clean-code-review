'use client';

import type { Answers } from '@/agent/lib/judging/schema';
import {
  type FileJudgment,
  isProsePath,
  type ReviewFile,
} from '@/agent/lib/review/review';

import {
  fileVerdict,
  PARTLY_JUDGED,
  type PartialCoverage,
  partialCoverage,
  smellCount,
  type Verdict,
  verdictFill,
  verdictScore,
} from './display';
import { FilePath, LangChip, ProseChip, SmellCount } from './FileCard';
import { PendingDot } from './PendingDot';

const PERCENT = 100;

export function FileList({
  files,
  judgments,
  failed,
  paused,
  stalled,
  allCollapsed,
  onToggleAll,
  onSelect,
}: {
  files: readonly ReviewFile[];
  judgments: Record<string, FileJudgment>;
  failed: Record<string, true>;
  paused: Record<string, true>;
  stalled: (path: string) => boolean;
  allCollapsed: boolean;
  onToggleAll: () => void;
  /** Expands that file's card and scrolls to it. */
  onSelect: (path: string) => void;
}) {
  return (
    <nav
      aria-label="Files in this review"
      className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem-var(--toast-space,0px))] lg:self-start lg:overflow-y-auto lg:overscroll-contain lg:p-1 lg:-m-1"
      data-rail={true}
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <h2 className="text-xs font-semibold tracking-wider text-muted uppercase">
          Files
        </h2>
        <button
          className="-my-1 ml-auto inline-flex min-h-10 shrink-0 cursor-pointer items-center px-1 text-xs text-muted hover:text-ink lg:my-0 lg:min-h-0 lg:px-0"
          data-toggle="all"
          onClick={onToggleAll}
          type="button"
        >
          {allCollapsed ? 'Expand all' : 'Collapse all'}
        </button>
      </div>
      {/* Below lg a sideways strip; the fade over the next card's edge
          signals it scrolls. At lg the wrapper dissolves into the sidebar. */}
      <div className="relative lg:contents">
        <ul className="flex gap-2 overflow-x-auto pb-2 lg:block lg:gap-0 lg:overflow-visible lg:pb-0">
          {files.map((file) => (
            <FileRow
              failed={failed[file.path] === true}
              file={file}
              judgment={judgments[file.path]}
              key={file.path}
              onSelect={onSelect}
              paused={paused[file.path] === true}
              stalled={stalled(file.path)}
            />
          ))}
        </ul>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0 right-0 bottom-2 w-10 bg-gradient-to-l from-page to-transparent lg:hidden"
        />
      </div>
    </nav>
  );
}

/** The rail's label and bar for one file. */
function Standing({
  answers,
  coverage,
  path,
  score,
  verdict,
}: {
  answers: Answers | undefined;
  path: string;
  coverage: PartialCoverage | null;
  score: number | null;
  verdict: Verdict;
}) {
  return (
    <>
      <span className="mt-1 flex flex-wrap items-center gap-1.5">
        <LangChip path={path} />
        {verdict.key === 'pending' ? <PendingDot /> : null}
        {/* The bar below still draws the verdict of the parts judged. */}
        <span className={`text-xs ${coverage ? 'text-warn' : 'text-muted'}`}>
          {coverage ? PARTLY_JUDGED : verdict.label}
        </span>
        {answers ? (
          <>
            <span className="text-xs text-subtle">·</span>
            <SmellCount
              atLeast={coverage?.unread}
              count={smellCount(answers)}
            />
          </>
        ) : null}
      </span>
      <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-track">
        <span
          className="block h-full rounded-full bg-ink motion-safe:transition-transform motion-safe:duration-300"
          style={{
            transform: `translateX(${(verdictFill(score) - 1) * PERCENT}%)`,
          }}
        />
      </span>
    </>
  );
}

function FileRow({
  file,
  judgment,
  failed,
  paused,
  stalled,
  onSelect,
}: {
  file: ReviewFile;
  judgment: FileJudgment | undefined;
  failed: boolean;
  paused: boolean;
  stalled: boolean;
  onSelect: (path: string) => void;
}) {
  // No verdict or bar for prose: both would read as a judgment.
  const prose = isProsePath(file.path);
  const answers = judgment?.answers;
  const score = prose ? null : verdictScore(answers);
  const verdict = prose
    ? null
    : fileVerdict(score, {
        empty: !file.content.trim(),
        failed,
        paused,
        stalled,
      });
  const coverage = prose ? null : partialCoverage(judgment);

  return (
    <li className="shrink-0 lg:shrink">
      <button
        className="w-72 cursor-pointer rounded-md px-2 py-1.5 text-left outline-offset-[-2px] hover:bg-surface lg:w-full"
        data-coverage={coverage ? 'partial' : undefined}
        data-file={file.path}
        data-verdict={verdict?.key}
        onClick={() => onSelect(file.path)}
        type="button"
      >
        <FilePath path={file.path} stacked={true} />
        {verdict === null ? (
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <LangChip path={file.path} />
            <ProseChip />
          </span>
        ) : (
          <Standing
            answers={answers}
            coverage={coverage}
            path={file.path}
            score={score}
            verdict={verdict}
          />
        )}
      </button>
    </li>
  );
}
