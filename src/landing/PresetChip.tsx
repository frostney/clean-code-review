'use client';

import { useReviewControls } from '@/src/review/ReviewProvider';
import { handOn } from '@/src/ui/hand-on';

// The only client part of the examples row; the row and labels are server-rendered.
export function PresetChip({ label, blurb }: { label: string; blurb: string }) {
  const { activePreset, openPreset } = useReviewControls();
  const active = activePreset === label;

  return (
    <button
      aria-pressed={active}
      className={`inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-xs motion-safe:transition-colors lg:min-h-0 lg:px-2.5 lg:py-1 ${
        active
          ? 'border-ink bg-ink text-page'
          : 'border-line bg-page text-muted hover:border-muted hover:text-ink'
      }`}
      data-preset={label}
      // The press takes the page into the review's layout, where this whole row
      // is gone, so the focus that made it is handed to the duck that opens
      // that layout rather than dropped on `<body>`.
      onClick={(event) => {
        handOn(event.currentTarget, '[data-duck=home]');
        openPreset(label);
      }}
      title={blurb}
      type="button"
    >
      {label}
    </button>
  );
}
