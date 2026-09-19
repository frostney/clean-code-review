'use client';

import { useEffect, useRef, useState } from 'react';

import { useReviewControls, useReviewView } from '@/src/review/ReviewProvider';

/**
 * The other way in: paste a diff, a file, or several files marked up with
 * `// file:` lines. Judging happens on submit rather than on every pause —
 * a paste arrives all at once, and there is nothing to coalesce.
 *
 * It is a modal, because pasting is a detour from reading a review rather than
 * a panel to keep open beside one: the native `<dialog>` brings its own
 * backdrop, its own Escape, and its own promise to hand focus back to whatever
 * opened it. The element stays mounted and is opened and closed imperatively,
 * which is what makes that promise keepable.
 *
 * It takes no props: whether it is open, what a judged paste does and where
 * focus goes afterwards are all the review's, and reading them here is what
 * lets the button that opens it stay a three-line island of its own.
 */
export function Paste() {
  const { pasting: open, stopPasting } = useReviewView();
  const { judgePasted, pasteButtonRef } = useReviewControls();
  const [text, setText] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
      // `autofocus` inside a dialog picks the first focusable thing, which is
      // the close button; the textarea is what this is for.
      textareaRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  /** The dialog closed, whichever of its three ways was used. */
  function onClose() {
    stopPasting();
    // A `<dialog>` hands focus back on its own, but only while it stays
    // mounted and focused; saying so is what makes it certain.
    pasteButtonRef.current?.focus();
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard way out of a <dialog> is Escape, and it arrives on onCancel below
    <dialog
      aria-label="Paste code or a diff"
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(48rem,calc(100vw-2rem))] overflow-auto overscroll-contain rounded-md border border-line bg-page p-0 text-ink backdrop:bg-scrim"
      data-paste={true}
      // Escape, the close button and a click on the backdrop all end here, so
      // the dialog's own state and the page's stay in step whichever was used.
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) {
          dialogRef.current?.close();
        }
      }}
      onClose={onClose}
      // 16px of margin on every side, and never taller than the viewport, so
      // the Judge button is always on screen without scrolling the page under
      // the modal. `dvh` rather than `vh`: on a phone the URL bar counts.
      ref={dialogRef}
    >
      <div className="flex items-center gap-3 border-b border-line bg-surface px-3 py-2">
        <h2 className="text-sm font-semibold text-ink">Paste code or a diff</h2>
        <button
          className="-my-2 ml-auto inline-flex min-h-10 shrink-0 cursor-pointer items-center px-1 text-xs text-muted hover:text-ink lg:my-0 lg:min-h-0 lg:px-0"
          data-paste="close"
          onClick={() => dialogRef.current?.close()}
          type="button"
        >
          Close
        </button>
      </div>
      <p className="border-b border-line px-3 py-2 text-xs text-muted">
        A unified diff is split per file; several files can be marked up with{' '}
        <code className="font-mono">&#47;&#47; file: path</code> lines.
      </p>
      <textarea
        aria-label="Code or diff to judge"
        className="code-line h-[40dvh] min-h-40 w-full resize-y border-0 bg-page px-3 py-2 text-ink outline-none placeholder:text-subtle focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent lg:h-56 lg:min-h-0"
        onChange={(e) => setText(e.target.value)}
        placeholder="diff --git a/src/thing.ts b/src/thing.ts&#10;…"
        ref={textareaRef}
        spellCheck={false}
        value={text}
        // Two fifths of the screen on a phone, where the dialog is the screen;
        // the fixed height it always had once there is a page around it.
        wrap="off"
      />
      <div className="flex items-center gap-3 border-t border-line px-3 py-2">
        <button
          className="inline-flex min-h-10 cursor-pointer items-center rounded-md bg-ink px-4 text-sm font-semibold text-page disabled:cursor-default disabled:bg-surface disabled:text-muted disabled:ring-1 disabled:ring-line disabled:ring-inset lg:min-h-0 lg:px-3 lg:py-1"
          data-paste="judge"
          disabled={!text.trim()}
          onClick={() => {
            // Close first: the review that opens behind it is the answer, and
            // a modal over it would only be in the way.
            dialogRef.current?.close();
            judgePasted(text);
          }}
          type="button"
        >
          Judge
        </button>
        <span className="text-xs text-muted">
          {text.length.toLocaleString()} characters
        </span>
      </div>
    </dialog>
  );
}
