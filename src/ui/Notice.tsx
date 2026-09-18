import type { ReactNode } from 'react';

/**
 * A one-off system message across the top of the page. Amber, not part of the
 * label/bar/answer vocabulary the rest of the page uses, because it is not a
 * judgment about the code.
 *
 * Extra props land on the wrapper, which is how each notice keeps its own
 * `data-*` hook for tests. A caller's `className` is merged rather than
 * overridden — spreading it last would drop the notice's own styling.
 */
export function Notice({
  children,
  className,
  ...rest
}: { children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`mb-4 rounded-md border border-warn/40 bg-warn-bg px-3 py-2 text-[13px] leading-relaxed text-warn ${className ?? ''}`}
    >
      {children}
    </div>
  );
}
