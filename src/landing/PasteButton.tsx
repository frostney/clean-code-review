'use client';

import { useReviewControls } from '@/src/review/ReviewProvider';

/** Opens the paste dialog, and is where focus lands again when it closes. */
export function PasteButton() {
  const { startPasting, pasteButtonRef } = useReviewControls();

  return (
    <button
      className="inline-flex min-h-10 cursor-pointer items-center text-[12px] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent lg:min-h-0"
      data-paste="open"
      onClick={startPasting}
      ref={pasteButtonRef}
      type="button"
    >
      Paste code or a diff
    </button>
  );
}
