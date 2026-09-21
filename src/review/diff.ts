type DiffKind = 'add' | 'del' | 'context' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffKind;
  /** "+", "-", " ", or "" when the line had none. */
  sign: string;
  /** Without the sign; what gets highlighted. */
  code: string;
  oldNo: number | null;
  newNo: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Matched by content rather than "everything before the first `@@`", so an
 * edited body (which has no headers) cannot turn its first lines into headers.
 */
const FILE_HEADER =
  /^(?:diff --git |index |--- |\+\+\+ |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/;

interface Cursor {
  newNo: number;
  oldNo: number;
}

function unnumberedLine(raw: string, kind: DiffKind): DiffLine {
  return { code: raw, kind, newNo: null, oldNo: null, sign: '' };
}

/** A line with no `+`, `-` or space prefix (e.g. half-typed in the editor) is context. */
function codeLine(raw: string, cursor: Cursor, inHunk: boolean): DiffLine {
  if (raw.startsWith('+')) {
    return {
      code: raw.slice(1),
      kind: 'add',
      newNo: inHunk ? cursor.newNo++ : null,
      oldNo: null,
      sign: '+',
    };
  }
  if (raw.startsWith('-')) {
    return {
      code: raw.slice(1),
      kind: 'del',
      newNo: null,
      oldNo: inHunk ? cursor.oldNo++ : null,
      sign: '-',
    };
  }
  const spaced = raw.startsWith(' ');

  return {
    code: spaced ? raw.slice(1) : raw,
    kind: 'context',
    newNo: inHunk ? cursor.newNo++ : null,
    oldNo: inHunk ? cursor.oldNo++ : null,
    sign: spaced ? ' ' : '',
  };
}

/**
 * Exactly one `DiffLine` per input line, trailing newline included: the
 * editor's textarea lies over these rows, and a missing row is one the caret
 * cannot reach.
 */
export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  const cursor: Cursor = { newNo: 0, oldNo: 0 };
  let inHunk = false;

  for (const raw of patch.split('\n')) {
    const hunk = HUNK.exec(raw);

    if (hunk) {
      const [, oldStart, newStart] = hunk;

      cursor.oldNo = Number(oldStart);
      cursor.newNo = Number(newStart);
      inHunk = true;
      lines.push(unnumberedLine(raw, 'hunk'));
      continue;
    }
    if (raw.startsWith('\\') || (!inHunk && FILE_HEADER.test(raw))) {
      lines.push(unnumberedLine(raw, 'meta'));
      continue;
    }
    lines.push(codeLine(raw, cursor, inHunk));
  }

  return lines;
}

export interface SplitPatch {
  /** Verbatim, so it can be put back. */
  header: string;
  body: string;
}

/**
 * Headers are not shown or edited; `withPatchHeader` restores them before
 * sending, because the agent parses the section as git wrote it.
 */
export function splitPatchHeader(content: string): SplitPatch {
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length && FILE_HEADER.test(lines[i])) {
    i++;
  }

  return {
    body: lines.slice(i).join('\n'),
    header: lines.slice(0, i).join('\n'),
  };
}

export function withPatchHeader(header: string, body: string): string {
  return header ? `${header}\n${body}` : body;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  return {
    added: lines.filter((l) => l.kind === 'add').length,
    removed: lines.filter((l) => l.kind === 'del').length,
  };
}
