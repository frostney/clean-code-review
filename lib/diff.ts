/**
 * A unified diff, read line by line so the page can render it the way a review
 * tool does: two gutters of line numbers, a background per line kind, and the
 * code itself still highlighted as its own language.
 */
export type DiffKind = "add" | "del" | "context" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffKind;
  /** The leading +/-/space this line was written with, or "" when it had none. */
  sign: string;
  /** The line without its leading +/-/space, which is what gets highlighted. */
  code: string;
  /** Line number on the left (before the change), when the line has one. */
  oldNo: number | null;
  /** Line number on the right (after the change), when the line has one. */
  newNo: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The lines git writes before a file's first hunk: they name the file and how
 * it changed, not what it says. They are what `splitPatchHeader` lifts off a
 * section, and they are recognised by what they are rather than by "everything
 * before the first `@@`", so that an edited body — which no longer has them —
 * cannot turn its own first lines into headers.
 */
const FILE_HEADER =
  /^(?:diff --git |index |--- |\+\+\+ |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/;

/**
 * Read a patch body line by line.
 *
 * Anything that is not a hunk header, a file header or `\ No newline` is a line
 * of the diff, classified by its first character — and a line that starts with
 * none of `+`, `-` or a space reads as context, which is what a half-typed line
 * in the editor is. Every input line produces exactly one `DiffLine`, trailing
 * newline included: the editor lays its textarea over these rows, and a row it
 * did not produce is a row the caret could not reach.
 */
export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", sign: "", code: raw, oldNo: null, newNo: null });
      continue;
    }
    // `\ No newline at end of file` is about the code, the headers are about
    // the file; neither belongs to either image, so neither gets a number.
    if (raw.startsWith("\\") || (!inHunk && FILE_HEADER.test(raw))) {
      lines.push({ kind: "meta", sign: "", code: raw, oldNo: null, newNo: null });
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", sign: "+", code: raw.slice(1), oldNo: null, newNo: inHunk ? newNo++ : null });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", sign: "-", code: raw.slice(1), oldNo: inHunk ? oldNo++ : null, newNo: null });
    } else {
      const spaced = raw.startsWith(" ");
      lines.push({
        kind: "context",
        sign: spaced ? " " : "",
        code: spaced ? raw.slice(1) : raw,
        oldNo: inHunk ? oldNo++ : null,
        newNo: inHunk ? newNo++ : null,
      });
    }
  }
  return lines;
}

/** A patch section split into the part that names the file and the part that is the change. */
export interface SplitPatch {
  /** The `diff --git`/`index`/`---`/`+++` run, kept verbatim so it can be put back. */
  header: string;
  /** The hunks: what the diff view renders and what the editor edits. */
  body: string;
}

/**
 * Lift a file section's headers off its hunks.
 *
 * The card header already names the file, and `diff --git a/… b/…` only says it
 * again in machine — so the headers are not shown, and not edited either. They
 * are kept beside the review and put back by `withPatchHeader` on the way to
 * the agent, which parses and reads the section as git wrote it.
 */
export function splitPatchHeader(content: string): SplitPatch {
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length && FILE_HEADER.test(lines[i])) i++;
  return { header: lines.slice(0, i).join("\n"), body: lines.slice(i).join("\n") };
}

/** The other direction: an edited body, back under the headers it came with. */
export function withPatchHeader(header: string, body: string): string {
  return header ? `${header}\n${body}` : body;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  return {
    added: lines.filter((l) => l.kind === "add").length,
    removed: lines.filter((l) => l.kind === "del").length,
  };
}
