'use client';

import { useReviewControls } from './ReviewProvider';

/**
 * One example, as a chip. The server renders the line these sit on and the
 * label inside each one; this is the click and the lit state, and nothing
 * else — which is the whole reason the examples line is not a client
 * component.
 */
export function PresetChip({ label, blurb }: { label: string; blurb: string }) {
  const { activePreset, openPreset } = useReviewControls();
  const active = activePreset === label;

  return (
    <button
      aria-pressed={active}
      className={`inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-[12px] transition-colors lg:min-h-0 lg:px-2.5 lg:py-1 ${
        active
          ? 'border-ink bg-ink text-page'
          : 'border-line bg-page text-muted hover:border-muted hover:text-ink'
      }`}
      data-preset={label}
      onClick={() => openPreset(label)}
      title={blurb}
      type="button"
    >
      {label}
    </button>
  );
}
