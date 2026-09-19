'use client';

import { type ReactNode, useState } from 'react';

// Folded so a long description cannot push the review off screen.
export function PullRequestBodyToggle({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-1 max-w-[80ch] min-w-0">
      <div
        className={`markdown text-sm leading-relaxed text-muted ${open ? '' : 'max-h-[16rem] overflow-hidden'}`}
        data-pr-body={open ? 'open' : 'clamped'}
      >
        {children}
      </div>
      <button
        className="mt-1 inline-flex min-h-10 cursor-pointer items-center text-xs text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent lg:min-h-0"
        data-pr-body-toggle={true}
        onClick={() => setOpen((shown) => !shown)}
        type="button"
      >
        {open ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
}
