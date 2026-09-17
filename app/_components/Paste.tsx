"use client";

import { useEffect, useRef, useState } from "react";

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
 */
export function Paste({
  open,
  onJudge,
  onClose,
}: {
  open: boolean;
  onJudge: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // `autofocus` inside a dialog picks the first focusable thing, which is
      // the close button; the textarea is what this is for.
      textareaRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      data-paste
      aria-label="Paste code or a diff"
      // Escape, the close button and a click on the backdrop all end here, so
      // the dialog's own state and the page's stay in step whichever was used.
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current?.close();
      }}
      className="m-auto w-[min(48rem,calc(100vw-2rem))] rounded-md border border-line bg-white p-0 text-ink backdrop:bg-ink/40"
    >
      <div className="flex items-center gap-3 border-b border-line bg-surface px-3 py-2">
        <h2 className="text-[13px] font-semibold text-ink">Paste code or a diff</h2>
        <button
          type="button"
          data-paste="close"
          onClick={() => dialogRef.current?.close()}
          className="ml-auto shrink-0 cursor-pointer text-[12px] text-muted hover:text-ink"
        >
          Close
        </button>
      </div>
      <p className="border-b border-line px-3 py-2 text-[12px] text-muted">
        A unified diff is split per file; several files can be marked up with{" "}
        <code className="font-mono">// file: path</code> lines.
      </p>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        wrap="off"
        aria-label="Code or diff to judge"
        placeholder="diff --git a/src/thing.ts b/src/thing.ts&#10;…"
        className="code-line h-56 w-full resize-y border-0 bg-white px-3 py-2 text-ink outline-none placeholder:text-muted/60"
      />
      <div className="flex items-center gap-3 border-t border-line px-3 py-2">
        <button
          type="button"
          data-paste="judge"
          disabled={!text.trim()}
          onClick={() => {
            // Close first: the review that opens behind it is the answer, and
            // a modal over it would only be in the way.
            dialogRef.current?.close();
            onJudge(text);
          }}
          className="cursor-pointer rounded-md bg-ink px-3 py-1 text-[13px] font-semibold text-white disabled:cursor-default disabled:opacity-40"
        >
          Judge
        </button>
        <span className="text-[12px] text-muted">{text.length.toLocaleString()} characters</span>
      </div>
    </dialog>
  );
}
