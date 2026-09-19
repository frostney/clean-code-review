'use client';

import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
} from 'react';

import { REVIEW_LIMITS } from '@/agent/lib/review/review';

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
 * A null `onChange` (prose files) drops the textarea: an editable card would
 * promise that typing changes an answer.
 */
function Overlay({
  path,
  content,
  onChange,
  gutters,
  children,
}: {
  path: string;
  content: string;
  onChange: ((next: string) => void) | null;
  gutters: ReactNode;
  children: ReactNode;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    function sync() {
      if (preRef.current && textarea) {
        preRef.current.scrollLeft = textarea.scrollLeft;
      }
    }
    textarea.addEventListener('scroll', sync, { passive: true });
    return () => textarea.removeEventListener('scroll', sync);
  }, []);

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
    if (next.length > REVIEW_LIMITS.maxCharsPerFile) {
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
          aria-hidden={onChange ? 'true' : undefined}
          className={`code-line ${onChange ? 'overflow-hidden' : 'overflow-auto'}`}
          ref={preRef}
          // Read-only code scrolls itself, so it must be keyboard-focusable.
          tabIndex={onChange ? undefined : 0}
        >
          {children}
        </pre>
        {onChange ? (
          <textarea
            aria-label={`Edit ${path}`}
            className="code-line absolute inset-0 w-full resize-none overflow-auto border-0 bg-transparent px-3 py-2 text-transparent caret-ink outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            maxLength={REVIEW_LIMITS.maxCharsPerFile}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            ref={textareaRef}
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
  onScreen,
}: {
  path: string;
  content: string;
  onChange: ((next: string) => void) | null;
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
  onScreen,
}: {
  path: string;
  content: string;
  onChange: ((next: string) => void) | null;
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
      path={path}
    >
      <DiffRows lines={lines} tokens={tokens} />
    </Overlay>
  );
}
