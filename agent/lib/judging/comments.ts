/**
 * The file as it would read with its comments gone, for the second judging
 * pass. Jev rewards comment volume rather than comment content: on code that
 * is byte-identical, filler comments that restate each signature and say
 * nothing move the mean verdict by +0.199 against a run-to-run noise of 0.055,
 * and flags that are purely about code move with them. So the code questions
 * are asked of this text and only the comment questions of the file as written.
 */

import { isHunkHeader, leavesHunk } from './patch';
import { commentRanges, familyOf } from './scan';

/**
 * A verdict that falls by more than this once the comments are gone rests on
 * them. Not lower because judging one file twice moves its verdict by 0.055 on
 * its own, and a threshold inside the noise would mark every file.
 */
export const COMMENT_LEAN_THRESHOLD = 0.2;

/**
 * Comments a tool reads rather than a person: removing them would change what
 * the code means or what the checks say about it.
 */
const TOOL_COMMENT =
  /^(?:#!|.{0,4}?\s*(?:biome-ignore|@ts-|eslint|knip|prettier-ignore|<reference|v8 ignore|c8 ignore|istanbul|webpackChunkName|@jsx|go:|nolint|noqa|type:\s*ignore|pragma|pylint|mypy|ruff|coding[:=]|-\*-|SPDX))/;

const TOOL_COMMENT_CHARS = 80;

function isToolComment(text: string): boolean {
  return TOOL_COMMENT.test(text.slice(0, TOOL_COMMENT_CHARS));
}

/** True where a character belongs to a comment that should go. */
function commentMask(text: string, path: string): Uint8Array | null {
  const ranges = commentRanges(text, path);

  if (ranges === null) {
    return null;
  }
  const mask = new Uint8Array(text.length);

  for (const { start, end } of ranges) {
    if (isToolComment(text.slice(start, end))) {
      continue;
    }
    mask.fill(1, start, end);
  }

  return mask;
}

/** What a line keeps, and whether anything was taken off it. */
function keptOf(
  line: string,
  mask: Uint8Array,
  at: number,
): { text: string; touched: boolean } {
  let text = '';
  let touched = false;

  for (let i = 0; i < line.length; i++) {
    if (mask[at + i]) {
      touched = true;
    } else {
      text += line[i];
    }
  }

  return { text: touched ? text.trimEnd() : text, touched };
}

/**
 * One entry per source line: the line without its comments, or null where the
 * line held nothing else and goes too. Aligned to the source so a judging
 * window can take the same line range from both passes.
 */
function withoutMasked(text: string, mask: Uint8Array): (string | null)[] {
  const out: (string | null)[] = [];
  let at = 0;

  for (const line of text.split('\n')) {
    const kept = keptOf(line, mask, at);

    at += line.length + 1;
    out.push(kept.touched && kept.text.trim() === '' ? null : kept.text);
  }

  return out;
}

interface Images {
  before: string[];
  after: string[];
  /** Per diff line: the image and line holding its content, or null. */
  source: ({ image: 'after' | 'before'; line: number } | null)[];
}

/**
 * The two sides of a diff as separate texts, each scannable on its own.
 * Hunks are separated by a blank line, as `afterImage` does, so an unterminated
 * construct in one hunk cannot run into the next.
 */
function imagesOf(lines: readonly string[]): Images {
  const images: Images = { after: [], before: [], source: [] };
  let inHunk = false;

  lines.forEach((line, i) => {
    if (isHunkHeader(line)) {
      images.before.push('');
      images.after.push('');
      images.source.push(null);
      inHunk = true;

      return;
    }
    if (inHunk && leavesHunk(line, lines[i + 1])) {
      inHunk = false;
    }
    const body = line.slice(1);

    if (!inHunk || line.startsWith('\\')) {
      images.source.push(null);
    } else if (line.startsWith('-')) {
      images.source.push({ image: 'before', line: images.before.length });
      images.before.push(body);
    } else if (line.startsWith('+')) {
      images.source.push({ image: 'after', line: images.after.length });
      images.after.push(body);
    } else {
      images.source.push({ image: 'after', line: images.after.length });
      images.before.push(body);
      images.after.push(body);
    }
  });

  return images;
}

/** Per line of the image, the mask over that line's characters. */
function lineMasks(lines: string[], path: string): Uint8Array[] | null {
  const text = lines.join('\n');
  const mask = commentMask(text, path);

  if (mask === null) {
    return null;
  }
  const out: Uint8Array[] = [];
  let at = 0;

  for (const line of lines) {
    out.push(mask.subarray(at, at + line.length));
    at += line.length + 1;
  }

  return out;
}

/**
 * Both sides of the diff lose their comments, so a change that only touched
 * comments becomes no change at all — which is why such a diff is null rather
 * than a diff with no changes left in it. Only hunk-body lines count: every
 * real patch also carries a `+++ b/…` header, which is not a change.
 * Hunk headers keep their original line counts; nothing downstream applies the
 * patch.
 */
function strippedPatch(
  lines: readonly string[],
  path: string,
): (string | null)[] | null {
  const images = imagesOf(lines);
  const after = lineMasks(images.after, path);
  const before = lineMasks(images.before, path);

  if (after === null || before === null) {
    return null;
  }
  const masks = { after, before };
  const out: (string | null)[] = [];
  let changed = 0;

  lines.forEach((line, i) => {
    const source = images.source[i];

    if (source === null) {
      // Outside every hunk: `diff --git`, `---`, `+++`, `\ No newline`.
      out.push(line);

      return;
    }
    const kept = keptOf(line.slice(1), masks[source.image][source.line], 0);

    if (kept.touched && kept.text.trim() === '') {
      out.push(null);

      return;
    }
    const marker = line.slice(0, 1);

    if (marker === '+' || marker === '-') {
      changed++;
    }
    out.push(marker + kept.text);
  });

  return changed > 0 ? out : null;
}

/**
 * `lines` is one entry per line of the source, null where the line went with
 * its comments, so a window over the source addresses the same code in both
 * passes. `unchanged` means the file has no comments to remove, so a second
 * pass would repeat the first and the lean is zero. `none` means there is no
 * second pass to be had: no scanner for the language, a construct the scanner
 * will not risk, or a diff whose every change was a comment, which would leave
 * nothing to judge.
 */
export type Stripped =
  | { kind: 'stripped'; lines: (string | null)[] }
  | { kind: 'unchanged' }
  | { kind: 'none' };

const UNCHANGED: Stripped = { kind: 'unchanged' };
const NONE: Stripped = { kind: 'none' };

/** The stripped text of one span of source lines, `[from, to)`. */
export function strippedText(
  lines: readonly (string | null)[],
  from = 0,
  to = lines.length,
): string {
  return lines
    .slice(from, to)
    .filter((line): line is string => line !== null)
    .join('\n');
}

function answerOf(
  lines: (string | null)[],
  source: readonly string[],
): Stripped {
  const same =
    lines.length === source.length &&
    lines.every((line, i) => line === source[i]);

  return same ? UNCHANGED : { kind: 'stripped', lines };
}

export function withoutComments(file: {
  path: string;
  content: string;
  patch?: boolean;
}): Stripped {
  if (familyOf(file.path) === null) {
    return NONE;
  }
  const source = file.content.split('\n');

  if (file.patch === true) {
    const stripped = strippedPatch(source, file.path);

    return stripped === null ? NONE : answerOf(stripped, source);
  }
  const mask = commentMask(file.content, file.path);

  return mask === null
    ? NONE
    : answerOf(withoutMasked(file.content, mask), source);
}
