import { type ReviewFile, skipReason } from '../review/review';

export function filesFromPatch(patch: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  const text = patch.replace(/\r\n?/g, '\n');
  // git diffs start each file with `diff --git`; plain `diff -u` output only
  // has the `---`/`+++` pair, so split on whichever the patch uses.
  const splitter = /^diff --git /m.test(text)
    ? /^(?=diff --git )/m
    : /^(?=--- (?:a\/|\S))(?=[^\n]*\n\+\+\+ )/m;
  const sections = text.split(splitter).filter((s) => s.trim());
  for (const section of sections) {
    // No hunk: binary files, pure renames, mode changes.
    if (!/^@@ /m.test(section)) {
      continue;
    }
    const target = /^\+\+\+ (?:b\/)?([^\t\n]+)/m.exec(section)?.[1]?.trim();
    if (target === '/dev/null') {
      continue;
    }
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
    const path = target || header?.[2] || header?.[1];
    if (!path) {
      continue;
    }
    const file: ReviewFile = {
      content: section.trimEnd(),
      patch: true,
      path: path.trim(),
    };
    if (skipReason(file) !== null) {
      continue;
    }
    files.push(file);
  }
  return files;
}

export function looksLikePatch(text: string): boolean {
  return (
    /^diff --git /m.test(text) ||
    (/^--- /m.test(text) && /^\+\+\+ /m.test(text) && /^@@ /m.test(text))
  );
}

/**
 * A hunk header, on either form of diff. A combined diff's `@@@` is recognised
 * so that every reader here agrees about where its hunks start, but its second
 * marker column is still read as body text: combined diffs cannot arrive
 * through `looksLikePatch` or `filesFromPatch`, only in a hand-built message.
 */
export function isHunkHeader(line: string): boolean {
  return /^@@+ /.test(line);
}

/** Every line of a hunk body carries one of these in its first column. */
const HUNK_MARKERS = ' +-\\';

/**
 * True where a hunk body ends and the next file's header begins. Without this
 * a second file's `+++ b/…` would read as a line the patch adds.
 */
export function leavesHunk(line: string, next: string | undefined): boolean {
  if (line === '') {
    return false;
  }
  if (!HUNK_MARKERS.includes(line[0])) {
    return true;
  }
  // `diff -u` output has no `diff --git` line to give the change away.
  return line.startsWith('--- ') && next?.startsWith('+++ ') === true;
}

/** The line as it appears after the change, or null when it does not. */
function afterLine(line: string): string | null {
  if (line.startsWith('+') || line.startsWith(' ')) {
    return line.slice(1);
  }
  return line === '' ? '' : null;
}

/**
 * Hunks are separated by a blank line rather than a marker, since any comment
 * syntax would be foreign to most languages.
 */
export function afterImage(patch: string): string {
  const out: string[] = [];
  let inHunk = false;
  const lines = patch.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, i) => {
    if (isHunkHeader(line)) {
      if (inHunk) {
        out.push('');
      }
      inHunk = true;
      return;
    }
    if (inHunk && leavesHunk(line, lines[i + 1])) {
      inHunk = false;
    }
    const after = inHunk ? afterLine(line) : null;
    if (after !== null) {
      out.push(after);
    }
  });
  return out.join('\n');
}
