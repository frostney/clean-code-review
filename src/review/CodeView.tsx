'use client';

import { type RefObject, useMemo } from 'react';

import type { DiffLine } from './diff';
import { type TokenLine, useTokens } from './highlight';
import type { Lang } from './language';

/**
 * How code is drawn on this page: line numbers, tokens, and the rows of a
 * unified diff. Every example is editable, so nothing here renders on its own —
 * these are the layer the `Editor` puts a textarea on top of, and the two share
 * the `.code-line` metrics to the pixel or the caret drifts.
 */

/** Padding shared by every gutter and every code column, so lines line up. */
const PAD_Y = 'py-2';

/** One highlighted line. Always renders something, so empty lines keep height. */
function Tokens({ line }: { line: TokenLine | undefined }) {
  if (!line || !line.length) {
    return <> </>;
  }
  return (
    <>
      {line.map((token, i) => (
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
    <div
      className={`code-line shrink-0 select-none border-r border-line bg-surface text-right text-muted ${PAD_Y}`}
    >
      {numbers.map((n, i) => (
        <div className={`px-2 ${backgrounds?.[i] ?? ''}`} key={i}>
          {n ?? ' '}
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
        <div key={i}>
          <Tokens line={line} />
        </div>
      ))}
    </div>
  );
}

const ROW_BACKGROUND: Record<DiffLine['kind'], string> = {
  add: 'bg-add-bg',
  context: '',
  del: 'bg-del-bg',
  hunk: 'bg-hunk-bg text-accent',
  meta: 'text-subtle',
};

const GUTTER_BACKGROUND: Record<DiffLine['kind'], string> = {
  add: 'bg-add-gutter text-ink',
  context: '',
  del: 'bg-del-gutter text-ink',
  hunk: 'bg-hunk-bg',
  meta: '',
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
export function useDiffTokens(
  lines: readonly DiffLine[],
  lang: Lang,
  debounceMs = 0,
  onScreen?: RefObject<boolean>,
): TokenLine[] {
  const stripped = useMemo(
    () =>
      lines
        .map((l) => (l.kind === 'hunk' || l.kind === 'meta' ? '' : l.code))
        .join('\n'),
    [lines],
  );
  return useTokens(stripped, lang, debounceMs, onScreen);
}

/**
 * A unified diff with its diff semantics intact: a background per line kind and
 * the code itself still highlighted as whatever language the file is.
 */
export function DiffRows({
  lines,
  tokens,
}: {
  lines: readonly DiffLine[];
  tokens: readonly TokenLine[];
}) {
  return (
    <div className={`min-w-max ${PAD_Y}`}>
      {lines.map((line, i) => (
        <div className={`px-3 ${ROW_BACKGROUND[line.kind]}`} key={i}>
          {line.kind === 'hunk' || line.kind === 'meta' ? (
            line.code || ' '
          ) : (
            <>
              {line.sign ? (
                <span className="select-none text-muted">{line.sign}</span>
              ) : null}
              <Tokens line={tokens[i]} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
