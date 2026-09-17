"use client";

import { type ReactNode, useState } from "react";

/**
 * The fold around a pull request's description.
 *
 * It is the author's own writing and the only prose on the page neither model
 * wrote, so it reads as a description under the title rather than as a block of
 * the review — 13px, muted, and folded to about a dozen lines with a toggle,
 * because a long description would otherwise push the whole review off screen.
 *
 * The description itself is a server-rendered node handed in as children; all
 * this adds is the state of the fold.
 */
export function PullRequestBodyToggle({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-1 max-w-[80ch] min-w-0">
      <div
        data-pr-body={open ? "open" : "clamped"}
        className={`markdown text-[13px] leading-relaxed text-muted ${open ? "" : "max-h-[16rem] overflow-hidden"}`}
      >
        {children}
      </div>
      <button
        type="button"
        data-pr-body-toggle
        onClick={() => setOpen((shown) => !shown)}
        className="mt-1 inline-flex min-h-10 cursor-pointer items-center text-[12px] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent lg:min-h-0"
      >
        {open ? "Show less" : "Show more"}
      </button>
    </div>
  );
}
