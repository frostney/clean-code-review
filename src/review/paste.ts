import { filesFromPatch, looksLikePatch } from '@/agent/lib/judging/patch';
import type { ReviewFile } from '@/agent/lib/review/review';

import { extensionFromContent, extensionFromHint } from './language';

const FILE_MARKER = /^(?:\/\/|#)\s*file:\s*(.+?)\s*$/;

/** A unified diff, a multi-file paste with `// file:` lines, or one snippet, tried in that order. */
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

  // Not `.txt`: that is a prose name, so the snippet would never be judged.
  return [
    { content: body, path: extension ? `snippet.${extension}` : 'snippet' },
  ];
}

/**
 * Keys, edits and judgments are all by path, so a duplicate would hide one
 * card. A second `src/a.ts` becomes `src/a (2).ts`.
 */
export function uniquePaths(files: readonly ReviewFile[]): ReviewFile[] {
  const taken = new Set<string>();

  return files.map((file) => {
    let path = file.path;

    // A suffixed name can itself collide.
    for (let n = 2; taken.has(path); n++) {
      path = suffixed(file.path, n);
    }
    taken.add(path);

    return path === file.path ? { ...file } : { ...file, path };
  });
}

/** Keeps the extension last: it picks the grammar. */
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

function stripFence(text: string): string {
  const lines = text.split('\n');

  if (!/^```/.test(lines[0] ?? '')) {
    return text;
  }
  const end = lines.findIndex((line, i) => i > 0 && /^```\s*$/.test(line));

  return lines.slice(1, end === -1 ? undefined : end).join('\n');
}
