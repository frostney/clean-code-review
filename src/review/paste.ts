import { filesFromPatch, looksLikePatch } from '@/agent/lib/judging/patch';
import type { ReviewFile } from '@/agent/lib/review/review';

import { extensionFromContent, extensionFromHint } from './language';

/** `// file: src/a.ts` or `# file: src/a.ts` on a line of its own. */
const FILE_MARKER = /^(?:\/\/|#)\s*file:\s*(.+?)\s*$/;

/**
 * Turn whatever was pasted into a review.
 *
 * Three shapes, in the order they are recognised: a unified diff (split per
 * file, judged as a change), a multi-file paste marked up with `// file:`
 * lines, and anything else — one snippet, named after whatever the first line
 * gives away about its language.
 */
export function filesFromPaste(text: string): ReviewFile[] {
  if (looksLikePatch(text)) {
    return uniquePaths(filesFromPatch(text));
  }
  const marked = filesFromMarkers(text);
  if (marked.length) {
    return uniquePaths(marked);
  }
  const body = stripFence(text);
  const extension =
    extensionFromHint(text.split('\n', 1)[0] ?? '') ??
    extensionFromContent(body);
  // No extension rather than `.txt` when nothing places it: `.txt` is a prose
  // name, and a snippet named that way would be shown and never judged.
  return [
    { content: body, path: extension ? `snippet.${extension}` : 'snippet' },
  ];
}

/**
 * Two files cannot share a path: React keys, edits and judgments are all by
 * path, so a duplicate would hide one card and merge the other's answers.
 * A second `src/a.ts` becomes `src/a (2).ts`, a third `src/a (3).ts`.
 */
export function uniquePaths(files: readonly ReviewFile[]): ReviewFile[] {
  const taken = new Set<string>();
  return files.map((file) => {
    let path = file.path;
    // A suffixed name can collide in turn, so keep counting until one is free.
    for (let n = 2; taken.has(path); n++) {
      path = suffixed(file.path, n);
    }
    taken.add(path);
    return path === file.path ? { ...file } : { ...file, path };
  });
}

/** `src/a.ts` + 2 → `src/a (2).ts`. The extension stays put: it picks the grammar. */
function suffixed(path: string, n: number): string {
  const base = path.lastIndexOf('/') + 1;
  const dot = path.lastIndexOf('.');
  return dot <= base
    ? `${path} (${n})`
    : `${path.slice(0, dot)} (${n})${path.slice(dot)}`;
}

function filesFromMarkers(text: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  let current: { path: string; lines: string[] } | null = null;
  for (const line of text.split('\n')) {
    const marker = FILE_MARKER.exec(line);
    if (marker) {
      if (current) {
        files.push({
          content: current.lines.join('\n').trim(),
          path: current.path,
        });
      }
      current = { lines: [], path: marker[1] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current) {
    files.push({
      content: current.lines.join('\n').trim(),
      path: current.path,
    });
  }
  return files.filter((f) => f.content.trim());
}

/** A pasted markdown fence is punctuation, not code. */
function stripFence(text: string): string {
  const lines = text.split('\n');
  if (!/^```/.test(lines[0] ?? '')) {
    return text;
  }
  const end = lines.findIndex((line, i) => i > 0 && /^```\s*$/.test(line));
  return lines.slice(1, end === -1 ? undefined : end).join('\n');
}
