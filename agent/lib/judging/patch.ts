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
 * Hunks are separated by a blank line rather than a marker, since any comment
 * syntax would be foreign to most languages.
 */
export function afterImage(patch: string): string {
  const out: string[] = [];
  let inHunk = false;
  for (const line of patch.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('@@')) {
      if (inHunk) {
        out.push('');
      }
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith('\\')) {
      continue; // "\ No newline at end of file"
    }
    if (line.startsWith('+')) {
      out.push(line.slice(1));
    } else if (line.startsWith(' ') || line === '') {
      out.push(line.slice(1));
    }
  }
  return out.join('\n');
}
