'use client';

import {
  type FileJudgment,
  isProsePath,
  type ReviewFile,
} from '@/agent/lib/review/review';

import { fileVerdict, smellCount, verdictFill, verdictScore } from './display';
import { FilePath, LangChip, ProseChip, SmellCount } from './FileCard';

/** The bar's fill is a fraction, and CSS wants it as a percentage. */
const PERCENT = 100;

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
  paused,
  allCollapsed,
  onToggleAll,
  onSelect,
}: {
  files: readonly ReviewFile[];
  judgments: Record<string, FileJudgment>;
  /** Paths Jev was asked about twice and answered for neither. */
  failed: Record<string, true>;
  /** Paths the site's model budget refused, each waiting for it to reset. */
  paused: Record<string, true>;
  /** Every card in the review is folded to its header. */
  allCollapsed: boolean;
  onToggleAll: () => void;
  /** Expand that file's card and bring it into view. */
  onSelect: (path: string) => void;
}) {
  return (
    <nav
      aria-label="Files in this review"
      className="min-w-0 lg:sticky lg:top-4"
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <h2 className="text-tiny font-semibold tracking-wider text-muted uppercase">
          Files
        </h2>
        <button
          className="-my-1 ml-auto inline-flex min-h-10 shrink-0 cursor-pointer items-center px-1 text-tiny text-muted hover:text-ink lg:my-0 lg:min-h-0 lg:px-0"
          data-toggle="all"
          onClick={onToggleAll}
          type="button"
        >
          {allCollapsed ? 'Expand all' : 'Collapse all'}
        </button>
      </div>
      {/* Below the two-column breakpoint the list is a strip: one card per
          file, scrolled sideways, with the next card's edge showing under a
          fade so the row reads as scrollable rather than as a cut-off list.
          The wrapper disappears at `lg`, where the strip becomes the sidebar
          the sticky `nav` was written for. */}
      <div className="relative lg:contents">
        <ul className="flex gap-2 overflow-x-auto pb-2 lg:block lg:gap-0 lg:overflow-visible lg:pb-0">
          {files.map((file) => {
            // Prose is listed but not judged, so the row says what the file is
            // and stops: a verdict word and a bar at zero would both read as a
            // judgment nobody made.
            const prose = isProsePath(file.path);
            const answers = judgments[file.path]?.answers;
            const score = prose ? null : verdictScore(answers);
            const verdict = prose
              ? null
              : fileVerdict(score, {
                  empty: !file.content.trim(),
                  failed: failed[file.path] === true,
                  paused: paused[file.path] === true,
                });
            return (
              <li className="shrink-0 lg:shrink" key={file.path}>
                <button
                  className="w-72 cursor-pointer rounded-md px-2 py-1.5 text-left hover:bg-surface lg:w-full"
                  data-file={file.path}
                  data-verdict={verdict?.key}
                  onClick={() => onSelect(file.path)}
                  type="button"
                >
                  <FilePath path={file.path} stacked={true} />
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <LangChip path={file.path} />
                    {verdict === null ? (
                      <ProseChip />
                    ) : (
                      <>
                        <span
                          className={`text-tiny text-muted ${verdict.key === 'pending' ? 'soft-pulse' : ''}`}
                        >
                          {verdict.label}
                        </span>
                        {answers ? (
                          <>
                            <span className="text-tiny text-muted/60">·</span>
                            <SmellCount count={smellCount(answers)} />
                          </>
                        ) : null}
                      </>
                    )}
                  </span>
                  {verdict === null ? null : (
                    <span className="mt-1 block h-1 w-full rounded-full bg-track">
                      <span
                        className="block h-full rounded-full bg-ink"
                        style={{
                          transition: 'width 300ms',
                          width: `${verdictFill(score) * PERCENT}%`,
                        }}
                      />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0 right-0 bottom-2 w-10 bg-gradient-to-l from-page to-transparent lg:hidden"
        />
      </div>
    </nav>
  );
}
