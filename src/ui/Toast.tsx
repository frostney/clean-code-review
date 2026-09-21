'use client';

import { CircleAlert, Info, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * Floats so nothing moves when it comes or goes: at the foot of the file list's
 * column from `lg` (the sticky list shrinks by `--toast-space`), across the
 * bottom on a phone (the page grows by the same space).
 *
 * Never takes focus. Announced through two always-present live regions (alert
 * for errors, status otherwise) rather than live toasts, which would read out
 * "Retry, Dismiss" too. Keyed by `raised` so a repeat is announced again.
 * Nothing times out: a slow reader must be able to finish it.
 */

type ToastTone = 'info' | 'warn' | 'error';

export interface ToastItem {
  /** One toast per id, updated in place. */
  id: string;
  /** A new value is announced again. */
  raised: number | string;
  tone: ToastTone;
  message: string;
  action?: { label: string; busyLabel: string; busy: boolean; run: () => void };
  onDismiss: () => void;
}

const TONE: Record<
  ToastTone,
  { icon: typeof Info; iconClass: string; edge: string; name: string }
> = {
  error: {
    edge: 'border-l-bad',
    icon: CircleAlert,
    iconClass: 'text-bad',
    name: 'Error',
  },
  info: {
    edge: 'border-l-accent',
    icon: Info,
    iconClass: 'text-accent',
    name: 'Note',
  },
  warn: {
    edge: 'border-l-warn',
    icon: TriangleAlert,
    iconClass: 'text-warn',
    name: 'Warning',
  },
};

function Toast({ item }: { item: ToastItem }) {
  const tone = TONE[item.tone];
  const Icon = tone.icon;

  return (
    <div
      className={`pointer-events-auto flex flex-wrap items-start gap-x-2.5 rounded-md border border-l-4 border-line-strong bg-page py-2 pr-1 pl-3 text-sm text-ink shadow-toast ${tone.edge} opacity-100 motion-safe:transition-[opacity,translate] motion-safe:duration-200 starting:translate-y-2 starting:opacity-0`}
      data-toast={item.tone}
    >
      <Icon
        aria-hidden="true"
        className={`mt-0.5 shrink-0 ${tone.iconClass}`}
        size={16}
      />
      <p className="min-w-0 flex-1 py-px leading-snug">
        <span className="sr-only">{tone.name}: </span>
        {item.message}
      </p>
      <div className="-my-1 flex shrink-0 items-center lg:my-0 lg:basis-full lg:justify-end">
        {item.action ? (
          <button
            aria-disabled={item.action.busy}
            className="inline-flex min-h-10 cursor-pointer items-center rounded-md px-2 font-semibold text-accent hover:underline aria-disabled:cursor-default aria-disabled:text-muted aria-disabled:no-underline lg:min-h-8"
            data-toast-action={true}
            // Not `disabled`: a disabled button drops the focus that pressed it.
            onClick={item.action.busy ? undefined : item.action.run}
            type="button"
          >
            {item.action.busy ? item.action.busyLabel : item.action.label}
          </button>
        ) : null}
        <button
          aria-label="Dismiss"
          className="inline-flex min-h-10 min-w-10 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-surface hover:text-ink lg:min-h-8 lg:min-w-8"
          data-toast-dismiss={true}
          onClick={item.onDismiss}
          type="button"
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>
    </div>
  );
}

export function ToastRegion({ toasts }: { toasts: readonly ToastItem[] }) {
  // Escape dismisses all, except while a dialog is open: there it is the
  // dialog's. Dismissing is the toast's own action and may call work off — the
  // pull request toast drops the fetch it is reporting on — so Escape means
  // what the cross means rather than "hide this": an answer arriving for a
  // reader who has cleared the notice would swap the review under them.
  // Read through a ref so the listener is not re-added every render.
  const current = useRef(toasts);

  current.current = toasts;
  const shown = toasts.length > 0;

  useEffect(() => {
    if (!shown) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector('dialog[open]')
      ) {
        return;
      }
      for (const toast of current.current) {
        toast.onDismiss();
      }
    }
    document.addEventListener('keydown', onKeyDown);

    return () => document.removeEventListener('keydown', onKeyDown);
  }, [shown]);

  // Written on `[data-rail]` and `[data-toast-room]` only: a custom property
  // on the root restyles every row of every card (the page's longest task).
  const stack = useRef<HTMLElement>(null);
  const [space, setSpace] = useState(0);

  useEffect(() => {
    const node = stack.current;

    if (!(shown && node)) {
      setSpace(0);

      return;
    }
    // Includes the home-indicator inset. `clientHeight`, not `innerHeight`,
    // which pinch-zoom shrinks while the fixed stack stays put.
    const measure = () =>
      setSpace(
        Math.max(
          0,
          Math.ceil(
            document.documentElement.clientHeight -
              node.getBoundingClientRect().top,
          ),
        ),
      );
    const observer = new ResizeObserver(measure);

    observer.observe(node);
    window.addEventListener('resize', measure);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [shown]);
  useEffect(() => {
    const rail = document.querySelector<HTMLElement>('[data-rail]');
    const room = document.querySelector<HTMLElement>('[data-toast-room]');

    if (space) {
      rail?.style.setProperty('--toast-space', `${space}px`);
    } else {
      rail?.style.removeProperty('--toast-space');
    }
    if (room) {
      room.style.height = `${space}px`;
    }
  }, [space]);

  const said = (loud: boolean) =>
    toasts
      // While retrying, "Retrying." is said instead; a repeat failure is a new node.
      .filter((t) => (t.tone === 'error') === loud && !t.action?.busy)
      .map((t) => <span key={`${t.id}:${t.raised}`}>{t.message} </span>);
  const busy = toasts.some((t) => t.action?.busy);

  return (
    <>
      <div className="sr-only" role="alert">
        {said(true)}
      </div>
      <output className="sr-only">
        {said(false)}
        {busy ? <span>Retrying.</span> : null}
      </output>
      {toasts.length ? (
        <section
          aria-label="Notifications"
          className="pointer-events-none fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-20 flex flex-col gap-2 lg:right-auto lg:left-[max(1rem,calc((100%-80rem)/2+1rem))] lg:w-64"
          data-toasts={true}
          ref={stack}
        >
          {toasts.map((item) => (
            <Toast item={item} key={item.id} />
          ))}
        </section>
      ) : null}
    </>
  );
}
