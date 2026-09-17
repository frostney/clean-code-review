import { type ReviewFile, skipReason } from './review';

/**
 * Split a unified diff (`git diff` / a GitHub `.patch`) into one ReviewFile
 * per touched file. Each file keeps only its own headers and hunks, so Jev
 * judges the change to that file and nothing else.
 */
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
    // Nothing to judge without a hunk: binary files, pure renames, mode changes.
    if (!/^@@ /m.test(section)) {
      continue;
    }
    const target = /^\+\+\+ (?:b\/)?([^\t\n]+)/m.exec(section)?.[1]?.trim();
    // A deleted file has no "after" to judge.
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
    // Images, binaries and generated files are not code to judge.
    if (skipReason(file) !== null) {
      continue;
    }
    files.push(file);
  }
  return files;
}

/** True when the text looks like a unified diff rather than a source file. */
export function looksLikePatch(text: string): boolean {
  return (
    /^diff --git /m.test(text) ||
    (/^--- /m.test(text) && /^\+\+\+ /m.test(text) && /^@@ /m.test(text))
  );
}

/**
 * The file as it reads after the change, as far as the hunks show it: context
 * and added lines, without the diff markers. Hunks are separated by a blank
 * line; no marker, since a marker in any one language's comment syntax would
 * read as foreign in the others.
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
    // '-' lines are the old code: not part of the after-image.
  }
  return out.join('\n');
}
