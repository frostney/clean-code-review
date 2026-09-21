/** Imported by the page, so it must stay free of server-only code. */
import { partitionJudgeable, REVIEW_LIMITS } from '../review/review';

function changedLines(patch: string): number {
  let n = 0;

  for (const line of patch.split('\n')) {
    if (
      (line[0] === '+' && !line.startsWith('+++')) ||
      (line[0] === '-' && !line.startsWith('---'))
    ) {
      n++;
    }
  }

  return n;
}

/**
 * Code is capped to the most-changed files; prose has its own allowance.
 * Kept files stay in diff order. `overCap` lists what the caps left out.
 */
export function selectReviewFiles<T extends { path: string; content: string }>(
  files: readonly T[],
  limit = REVIEW_LIMITS.maxFiles,
  proseLimit = REVIEW_LIMITS.maxProseFiles,
): { kept: T[]; skipped: string[]; overCap: string[] } {
  const { judgeable, prose, skipped } = partitionJudgeable(files);
  const ranked = [...judgeable].sort(
    (a, b) => changedLines(b.content) - changedLines(a.content),
  );
  const keep = new Set([
    ...ranked.slice(0, limit).map((f) => f.path),
    ...prose.slice(0, proseLimit).map((f) => f.path),
  ]);
  const candidates = files.filter(
    (f) => !skipped.some((s) => s.path === f.path),
  );

  return {
    kept: candidates.filter((f) => keep.has(f.path)),
    overCap: candidates.filter((f) => !keep.has(f.path)).map((f) => f.path),
    skipped: skipped.map((s) => s.path),
  };
}
