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

/** Below the threshold where the colours look like they lag the caret. */
const HIGHLIGHT_DEBOUNCE_MS = 50;

const INDENT = '  ';

/**
 * The classic overlay: a transparent textarea sits exactly on top of the
 * highlighted code, so the caret, the selection and the browser's own editing
 * are real while the colours underneath are ours. The two layers share the
 * `.code-line` metrics, and the textarea is the element that scrolls — the
 * highlighted layer is told to follow it.
 *
 * Both kinds of example are edited through this: a whole file, and the body of
 * a diff. What changes between them is only what is drawn underneath and how
 * many gutters stand beside it.
 *
 * A null `onChange` drops the textarea and leaves the highlighted layer on its
 * own, scrolling itself. That is what a prose file gets: a README is on the
 * page to be read, nothing here judges it, and an editable card would promise
 * that typing in it changes an answer.
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
  /** Null for a file that is shown and not edited. */
  onChange: ((next: string) => void) | null;
  gutters: ReactNode;
  children: ReactNode;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // A native listener rather than React's onScroll: scroll does not bubble,
  // and React's delegated handler does not reach this textarea.
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

  /** Tab indents the file instead of leaving the editor. */
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
    // At the limit an indent would push characters off the far end of the
    // file. Better to do nothing than to edit code out of sight.
    if (next.length > REVIEW_LIMITS.maxCharsPerFile) {
      return;
    }
    onChange(next);
    // React re-renders from state, so the caret has to be restored afterwards.
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
          // Read-only code scrolls sideways on its own, so it has to be
          // reachable by keyboard the way the textarea is when it is editable.
          tabIndex={onChange ? undefined : 0}
        >
          {children}
        </pre>
        {onChange ? (
          <textarea
            aria-label={`Edit ${path}`}
            className="code-line absolute inset-0 w-full resize-none overflow-auto border-0 bg-transparent px-3 py-2 text-transparent caret-ink outline-none"
            maxLength={REVIEW_LIMITS.maxCharsPerFile}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            ref={textareaRef}
            spellCheck={false}
            value={content}
            wrap="off"
          />
        ) : null}
        {/* A phone is narrower than almost any line of code, so the card's
            right edge is where the line continues rather than where it ends.
            A hairline of shadow says so — over a plain row and over a tinted
            diff row alike, which a white fade could not do. It is off above
            the breakpoint, where a card is wide enough that most lines finish
            inside it and a permanent edge would be a lie. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-ink/15 to-transparent lg:hidden"
        />
      </div>
    </div>
  );
}

/** A whole file, editable in place — or, with a null `onChange`, only read. */
export function Editor({
  path,
  content,
  onChange,
  onScreen,
}: {
  path: string;
  content: string;
  onChange: ((next: string) => void) | null;
  /** Whether the card is in view, so its colours go before those out of sight. */
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
 * A change to a file, editable in place too.
 *
 * What is edited is the body of the section — the hunks — because the headers
 * above them are the file's name in machine, not its code; `splitPatchHeader`
 * took them off upstream and puts them back on the way to the agent. Nothing
 * here tries to keep a `@@ -a,b +c,d @@` count honest as the text moves: the
 * body is simply re-read on every keystroke, so the two gutters and the
 * backgrounds always describe the diff as it now reads.
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
  /** Whether the card is in view, so its colours go before those out of sight. */
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
