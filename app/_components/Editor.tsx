"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef } from "react";
import { REVIEW_LIMITS } from "@/agent/lib/review";
import { parsePatch } from "@/lib/diff";
import { useTokens } from "@/lib/highlight";
import { langOf } from "@/lib/language";
import { CodeRows, DiffRows, Gutter, gutterBackgrounds, useDiffTokens } from "./CodeView";

/** Below the threshold where the colours look like they lag the caret. */
const HIGHLIGHT_DEBOUNCE_MS = 50;

const INDENT = "  ";

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
  onChange: (next: string) => void;
  gutters: ReactNode;
  children: ReactNode;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // A native listener rather than React's onScroll: scroll does not bubble,
  // and React's delegated handler does not reach this textarea.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    function sync() {
      if (preRef.current && textarea) preRef.current.scrollLeft = textarea.scrollLeft;
    }
    textarea.addEventListener("scroll", sync, { passive: true });
    return () => textarea.removeEventListener("scroll", sync);
  }, []);

  /** Tab indents the file instead of leaving the editor. */
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // While an IME composition is open, Tab belongs to the candidate list.
    if (e.key !== "Tab" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: start, selectionEnd: end, value } = el;
    const next = `${value.slice(0, start)}${INDENT}${value.slice(end)}`;
    // At the limit an indent would push characters off the far end of the
    // file. Better to do nothing than to edit code out of sight.
    if (next.length > REVIEW_LIMITS.maxCharsPerFile) return;
    onChange(next);
    // React re-renders from state, so the caret has to be restored afterwards.
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + INDENT.length;
    });
  }

  return (
    <div className="flex min-w-0">
      {gutters}
      <div className="relative min-w-0 flex-1">
        <pre ref={preRef} aria-hidden="true" className="code-line overflow-hidden">
          {children}
        </pre>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          wrap="off"
          maxLength={REVIEW_LIMITS.maxCharsPerFile}
          aria-label={`Edit ${path}`}
          className="code-line absolute inset-0 w-full resize-none overflow-auto border-0 bg-transparent px-3 py-2 text-transparent caret-ink outline-none"
        />
      </div>
    </div>
  );
}

/** A whole file, editable in place. */
export function Editor({ path, content, onChange }: { path: string; content: string; onChange: (next: string) => void }) {
  const lines = useTokens(content, langOf(path), HIGHLIGHT_DEBOUNCE_MS);
  const numbers = useMemo(() => lines.map((_, i) => i + 1), [lines]);

  return (
    <Overlay path={path} content={content} onChange={onChange} gutters={<Gutter numbers={numbers} />}>
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
}: {
  path: string;
  content: string;
  onChange: (next: string) => void;
}) {
  const lines = useMemo(() => parsePatch(content), [content]);
  const tokens = useDiffTokens(lines, langOf(path), HIGHLIGHT_DEBOUNCE_MS);
  const oldNumbers = useMemo(() => lines.map((l) => l.oldNo), [lines]);
  const newNumbers = useMemo(() => lines.map((l) => l.newNo), [lines]);
  const backgrounds = useMemo(() => gutterBackgrounds(lines), [lines]);

  return (
    <Overlay
      path={path}
      content={content}
      onChange={onChange}
      gutters={
        <>
          <Gutter numbers={oldNumbers} backgrounds={backgrounds} />
          <Gutter numbers={newNumbers} backgrounds={backgrounds} />
        </>
      }
    >
      <DiffRows lines={lines} tokens={tokens} />
    </Overlay>
  );
}
