import type { ReactNode } from 'react';

/**
 * A standing message (a transient one is a toast). Amber is reserved for what
 * limits the review. `className` is merged, not spread, so the notice keeps its
 * own styling.
 */
const TONE = {
  error: 'border-bad/40 bg-bad-bg text-bad',
  info: 'border-line bg-surface text-muted',
  warn: 'border-warn/40 bg-warn-bg text-warn',
} as const;

export function Notice({
  children,
  className,
  tone = 'info',
  ...rest
}: {
  children: ReactNode;
  tone?: keyof typeof TONE;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`mb-4 rounded-md border px-3 py-2 text-sm leading-relaxed ${TONE[tone]} ${className ?? ''}`}
      data-tone={tone}
    >
      {children}
    </div>
  );
}
