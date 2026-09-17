"use client";

import { useMemo } from "react";
import type { DiffLine } from "@/lib/diff";
import { type TokenLine, useTokens } from "@/lib/highlight";
import type { Lang } from "@/lib/language";

/**
 * How code is drawn on this page: line numbers, tokens, and the rows of a
 * unified diff. Every example is editable, so nothing here renders on its own —
 * these are the layer the `Editor` puts a textarea on top of, and the two share
 * the `.code-line` metrics to the pixel or the caret drifts.
 */

/** Padding shared by every gutter and every code column, so lines line up. */
export const PAD_Y = "py-2";

/** One highlighted line. Always renders something, so empty lines keep height. */
export function Tokens({ line }: { line: TokenLine | undefined }) {
  if (!line || !line.length) return <> </>;
  return (
    <>
      {line.map((token, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no identity beyond position
        <span key={i} style={token.color ? { color: token.color } : undefined}>
          {token.content}
        </span>
      ))}
    </>
  );
}

/** A column of line numbers that does not scroll with the code beside it. */
export function Gutter({
  numbers,
  backgrounds,
}: {
  numbers: readonly (number | null)[];
  backgrounds?: readonly string[];
}) {
  return (
    <div className={`code-line shrink-0 select-none border-r border-line bg-surface text-right text-muted/70 ${PAD_Y}`}>
      {numbers.map((n, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a gutter cell is its line
        <div key={i} className={`px-2 ${backgrounds?.[i] ?? ""}`}>
          {n ?? " "}
        </div>
      ))}
    </div>
  );
}

/** Plain code: one row per line, nothing but the tokens. */
export function CodeRows({ lines }: { lines: readonly TokenLine[] }) {
  return (
    <div className={`min-w-max px-3 ${PAD_Y}`}>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a row is its line
        <div key={i}>
          <Tokens line={line} />
        </div>
      ))}
    </div>
  );
}

const ROW_BACKGROUND: Record<DiffLine["kind"], string> = {
  add: "bg-add-bg",
  del: "bg-del-bg",
  hunk: "bg-hunk-bg text-accent",
  meta: "text-muted/70",
  context: "",
};

const GUTTER_BACKGROUND: Record<DiffLine["kind"], string> = {
  add: "bg-add-gutter",
  del: "bg-del-gutter",
  hunk: "bg-hunk-bg",
  meta: "",
  context: "",
};

export function gutterBackgrounds(lines: readonly DiffLine[]): string[] {
  return lines.map((l) => GUTTER_BACKGROUND[l.kind]);
}

/**
 * Tokenise a diff's code as the file's own language.
 *
 * The +/-/space column is taken off before highlighting and put back
 * afterwards, so a grammar never sees a leading sign; hunk and meta lines
 * contribute an empty line each, which keeps the tokens index-aligned with the
 * rows. Each row renders `sign + code`, which is the line exactly as it was
 * typed — the textarea above it has to agree character for character.
 */
export function useDiffTokens(lines: readonly DiffLine[], lang: Lang, debounceMs = 0): TokenLine[] {
  const stripped = useMemo(
    () => lines.map((l) => (l.kind === "hunk" || l.kind === "meta" ? "" : l.code)).join("\n"),
    [lines],
  );
  return useTokens(stripped, lang, debounceMs);
}

/**
 * A unified diff with its diff semantics intact: a background per line kind and
 * the code itself still highlighted as whatever language the file is.
 */
export function DiffRows({ lines, tokens }: { lines: readonly DiffLine[]; tokens: readonly TokenLine[] }) {
  return (
    <div className={`min-w-max ${PAD_Y}`}>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a row is its line
        <div key={i} className={`px-3 ${ROW_BACKGROUND[line.kind]}`}>
          {line.kind === "hunk" || line.kind === "meta" ? (
            line.code || " "
          ) : (
            <>
              {line.sign && <span className="select-none text-muted/60">{line.sign}</span>}
              <Tokens line={tokens[i]} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
