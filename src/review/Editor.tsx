'use client';

import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type UIEvent,
  useMemo,
  useRef,
} from 'react';

import { MAX_JUDGED_CHARS } from '@/agent/lib/review/review';

import {
  CodeRows,
  DiffRows,
  Gutter,
  gutterBackgrounds,
  useDiffTokens,
} from './CodeView';
import { parsePatch } from './diff';
import { useTokens } from './highlight';
import { langOf } from './language';

/** Below the delay at which colours visibly lag the caret. */
const HIGHLIGHT_DEBOUNCE_MS = 50;

const INDENT = '  ';

/**
 * A transparent textarea over the highlighted code, so caret, selection and
 * editing are native. Both layers must share the `.code-line` metrics; the
 * textarea scrolls and the highlighted layer follows.
 *
 * Prose files drop the textarea (`overlaid` false) and scroll the highlighted
 * layer instead: an editable card would promise that typing changes an answer.
 * A code file shown in part keeps the textarea, read-only, so its sideways
 * scrollbar stays inside it — outside, its height is one the reserved space
 * cannot predict, and the card would lose `content-visibility`.
 */
function Overlay({
  path,
  content,
  onChange,
  overlaid,
  gutters,
  children,
}: {
  path: string;
  content: string;
  onChange: ((next: string) => void) | null;
  overlaid: boolean;
  gutters: ReactNode;
  children: ReactNode;
}) {
  const preRef = useRef<HTMLPreElement>(null);

  function onScroll(e: UIEvent<HTMLTextAreaElement>) {
    if (preRef.current) {
      preRef.current.scrollLeft = e.currentTarget.scrollLeft;
    }
  }

  /** Tab indents instead of moving focus; Shift+Tab still leaves. */
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // While an IME composition is open, Tab belongs to the candidate list.
    if (
      !onChange ||
      e.key !== 'Tab' ||
      e.shiftKey ||
      e.nativeEvent.isComposing
    ) {
      return;
    }
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: start, selectionEnd: end, value } = el;
    const next = `${value.slice(0, start)}${INDENT}${value.slice(end)}`;

    // Past the limit the indent would cut characters off the end, out of sight.
    if (next.length > MAX_JUDGED_CHARS) {
      return;
    }
    onChange(next);
    // The controlled value resets the caret on re-render.
    requestAnimationFrame(() => {
      const caret = start + INDENT.length;

      el.selectionStart = caret;
      el.selectionEnd = caret;
    });
  }

  return (
    <div className="flex min-w-0">
      {gutters}
      <div className="relative min-w-0 flex-1">
        <pre
          aria-hidden={overlaid ? 'true' : undefined}
          className={`code-line ${overlaid ? 'overflow-hidden' : 'overflow-auto'}`}
          ref={preRef}
          // Prose scrolls itself, so it must be keyboard-focusable.
          tabIndex={overlaid ? undefined : 0}
        >
          {children}
        </pre>
        {overlaid ? (
          <textarea
            aria-label={onChange ? `Edit ${path}` : path}
            className="code-line absolute inset-0 w-full resize-none overflow-auto border-0 bg-transparent px-3 py-2 text-transparent caret-ink outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            maxLength={MAX_JUDGED_CHARS}
            onChange={onChange ? (e) => onChange(e.target.value) : undefined}
            onKeyDown={onKeyDown}
            onScroll={onScroll}
            readOnly={onChange === null}
            spellCheck={false}
            value={content}
            wrap="off"
          />
        ) : null}
        {/* On phones most lines overflow, so a shadow marks that the line
            continues; a shadow, unlike a white fade, works over tinted diff
            rows. Hidden at lg, where most lines fit. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-ink/15 to-transparent lg:hidden"
        />
      </div>
    </div>
  );
}

export function Editor({
  path,
  content,
  onChange,
  overlaid,
  onScreen,
}: {
  path: string;
  content: string;
  onChange: ((next: string) => void) | null;
  /** False only for prose, which scrolls its own highlighted layer. */
  overlaid: boolean;
  onScreen?: RefObject<boolean>;
}) {
  const lines = useTokens(
    content,
    langOf(path),
    HIGHLIGHT_DEBOUNCE_MS,
    onScreen,
  );
  const numbers = useMemo(() => lines.map((_, i) => i + 1), [lines]);

  return (
    <Overlay
      content={content}
      gutters={<Gutter numbers={numbers} />}
      onChange={onChange}
      overlaid={overlaid}
      path={path}
    >
      <CodeRows lines={lines} />
    </Overlay>
  );
}

/**
 * Edits only the hunks; headers are split off upstream and restored by
 * `withPatchHeader` before sending. `@@` counts are not kept honest as the
 * text changes: the body is re-parsed on every keystroke instead.
 */
export function PatchEditor({
  path,
  content,
  onChange,
  overlaid,
  onScreen,
}: {
  path: string;
  content: string;
  onChange: ((next: string) => void) | null;
  /** False only for prose, which scrolls its own highlighted layer. */
  overlaid: boolean;
  onScreen?: RefObject<boolean>;
}) {
  const lines = useMemo(() => parsePatch(content), [content]);
  const tokens = useDiffTokens(
    lines,
    langOf(path),
    HIGHLIGHT_DEBOUNCE_MS,
    onScreen,
  );
  const oldNumbers = useMemo(() => lines.map((l) => l.oldNo), [lines]);
  const newNumbers = useMemo(() => lines.map((l) => l.newNo), [lines]);
  const backgrounds = useMemo(() => gutterBackgrounds(lines), [lines]);

  return (
    <Overlay
      content={content}
      gutters={
        <>
          <Gutter backgrounds={backgrounds} numbers={oldNumbers} />
          <Gutter backgrounds={backgrounds} numbers={newNumbers} />
        </>
      }
      onChange={onChange}
      overlaid={overlaid}
      path={path}
    >
      <DiffRows lines={lines} tokens={tokens} />
    </Overlay>
  );
}
