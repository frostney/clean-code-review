/**
 * Which files of a pull request to judge. Kept free of server-only code so the
 * page can import it: no fetch, no tokens.
 */
import { REVIEW_LIMITS, skipReason } from './review';

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
 * The files worth judging from a pull request: generated and non-code files
 * skipped, the rest ordered by how much changed, capped at the review limit.
 * Keeps the diff's own order among the kept files so the page reads top-down.
 */
export function selectReviewFiles<T extends { path: string; content: string }>(
  files: readonly T[],
  limit = REVIEW_LIMITS.maxFiles,
): { kept: T[]; skipped: string[]; dropped: string[] } {
  const skipped = files
    .filter((f) => skipReason(f) !== null)
    .map((f) => f.path);
  const candidates = files.filter((f) => skipReason(f) === null);
  const ranked = [...candidates].sort(
    (a, b) => changedLines(b.content) - changedLines(a.content),
  );
  const keep = new Set(ranked.slice(0, limit).map((f) => f.path));
  return {
    dropped: candidates.filter((f) => !keep.has(f.path)).map((f) => f.path),
    kept: candidates.filter((f) => keep.has(f.path)),
    skipped,
  };
}
