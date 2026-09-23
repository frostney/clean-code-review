'use client';

import { type RefObject, useMemo } from 'react';

import type { DiffLine } from './diff';
import { type TokenLine, useTokens } from './highlight';
import type { Lang } from './language';

// The layer `Editor` lays its textarea over (read-only prose files render it
// alone). Both must share the `.code-line` metrics to the pixel or the caret
// drifts.

/** Shared by every gutter and code column so lines line up. */
const PAD_Y = 'py-2';

/** Always renders something, so empty lines keep their height. */
function Tokens({ line }: { line: TokenLine | undefined }) {
  if (!line?.length) {
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
 * Signs are stripped so the grammar never sees them; hunk and meta lines
 * become empty lines to keep tokens index-aligned with rows. Each row renders
 * `sign + code`, matching the textarea character for character.
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
