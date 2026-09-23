import { isProsePath, type ReviewFile } from '@/agent/lib/review/review';

import { partialCoverage } from './display';
import type { ReviewState } from './useReview';

/** Files the coverage toast names, by what is missing from each. */
export interface Gaps {
  /** Given up on after two turns without an answer to their current code. */
  unjudged: string[];
  /** Some windows went unread in both readings. */
  partial: string[];
  /** Every window was read, but not in both readings. */
  oneReading: string[];
}

/** Files on screen whose last answer is missing or partial, and not being asked about. */
export function judgingGaps(
  files: readonly ReviewFile[],
  s: Pick<ReviewState, 'givenUp' | 'judgments' | 'pausedFiles' | 'pending'>,
): Gaps {
  const gaps: Gaps = { oneReading: [], partial: [], unjudged: [] };

  for (const { path, content } of files) {
    if (
      isProsePath(path) ||
      !content.trim() ||
      s.pending[path] === true ||
      s.pausedFiles[path] === true
    ) {
      continue;
    }
    const coverage = partialCoverage(s.judgments[path]);

    // A given-up file holds a judgment only of the code on screen (the page
    // drops one of other code), so that judgment says what is missing.
    if (coverage && coverage.read < coverage.planned) {
      gaps.partial.push(path);
    } else if (coverage) {
      gaps.oneReading.push(path);
    } else if (s.givenUp[path] === true) {
      gaps.unjudged.push(path);
    }
  }

  return gaps;
}

export function gapPaths(gaps: Gaps): string[] {
  return [...gaps.unjudged, ...gaps.partial, ...gaps.oneReading];
}

function filesText(n: number, first: boolean): string {
  if (n === 1) {
    return first ? 'one file' : 'one';
  }

  return first ? `${n} files` : String(n);
}

function listed(clauses: readonly string[]): string {
  return clauses.length > 1
    ? `${clauses.slice(0, -1).join(', ')} and ${clauses.at(-1)}`
    : (clauses[0] ?? '');
}

/** e.g. "Jev sent no answer for one file and judged 2 only in part." */
export function gapsSentence({ unjudged, partial, oneReading }: Gaps): string {
  const clauses: string[] = [];
  const counted = (n: number) => filesText(n, clauses.length === 0);

  if (unjudged.length) {
    clauses.push(`sent no answer for ${counted(unjudged.length)}`);
  }
  if (partial.length) {
    clauses.push(`judged ${counted(partial.length)} only in part`);
  }
  if (oneReading.length) {
    clauses.push(
      `read part of ${counted(oneReading.length)} only with or only without ${oneReading.length === 1 ? 'its' : 'their'} comments`,
    );
  }
  const covers =
    partial.length + oneReading.length
      ? ' Each card says what its verdict covers.'
      : '';

  return `Jev ${listed(clauses)}.${covers}`;
}
