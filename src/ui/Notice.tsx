import type { ReactNode } from 'react';

/**
 * A standing system message above the review: not a judgment about the code,
 * and not something that just happened (that is a toast). Three tones, so the
 * amber is left for what actually needs care: `info` for what the reader
 * should know (a docs-only change), `warn` for what limits the review (a spent
 * budget), `error` for what stopped it.
 *
 * Extra props land on the wrapper, which is how each notice keeps its own
 * `data-*` hook for tests. A caller's `className` is merged rather than
 * overridden — spreading it last would drop the notice's own styling.
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
