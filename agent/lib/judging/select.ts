/**
 * Which files of a pull request to judge. Kept free of server-only code so the
 * page can import it: no fetch, no tokens.
 */
import { partitionJudgeable, REVIEW_LIMITS } from '../review/review';

/** Added plus removed lines in one file's diff section. */
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
 * The files worth showing from a pull request: generated and non-code files
 * skipped; the code ordered by how much changed and capped at the review
 * limit; the prose — READMEs, docs — kept in its own, smaller allowance, since
 * it is read and not judged. Keeps the diff's own order among the kept files
 * so the page reads top-down. `dropped` is every file the caps left out.
 */
export function selectReviewFiles<T extends { path: string; content: string }>(
  files: readonly T[],
  limit = REVIEW_LIMITS.maxFiles,
  proseLimit = REVIEW_LIMITS.maxProseFiles,
): { kept: T[]; skipped: string[]; dropped: string[] } {
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
    dropped: candidates.filter((f) => !keep.has(f.path)).map((f) => f.path),
    kept: candidates.filter((f) => keep.has(f.path)),
    skipped: skipped.map((s) => s.path),
  };
}
