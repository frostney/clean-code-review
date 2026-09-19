'use client';

import { CircleAlert, Info, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * Something the page has to say while a review is being read: a pull request
 * that did not open, a judging turn that failed. It floats rather than taking
 * a row, so nothing on the page moves when it arrives or leaves.
 *
 * Where it floats is the decision. From `lg` up it stands at the foot of the
 * file list's column, as wide as the list, never over code; the list, which
 * sticks to the top of the screen, gives up the toasts' height at its bottom
 * while they are up (`--toast-space` on `[data-rail]`, measured here), so
 * once it is stuck no row of it is under them either. On a phone there is no
 * margin to use, so it spans the bottom of the screen above the home
 * indicator, and the page gains the same space at its end so the last lines
 * can scroll clear. It goes
 * away with its own button, or with Escape anywhere on the page while no
 * dialog is open.
 *
 * It never takes focus. What it says is repeated into two live regions that
 * are on the page from the first paint, so it is announced when it arrives:
 * errors through `role="alert"`, which interrupts, and warnings and notes
 * through `role="status"`, which waits. The toasts themselves are not live,
 * or every announcement would end in "Retry, Dismiss". Each message is its
 * own node keyed by how many times it was raised, so a failure that comes
 * back in the same words is announced again; a retry under way is announced
 * as "Retrying." in the polite region. Nothing times out,
 * because an error that leaves on its own leaves before a slow reader has
 * finished it.
 */

type ToastTone = 'info' | 'warn' | 'error';

export interface ToastItem {
  /** The kind of thing being said; one toast per kind, updated in place. */
  id: string;
  /** Which raising of it this is: a new value is said again. */
  raised: number | string;
  tone: ToastTone;
  message: string;
  /** The one thing that can be done about it, when there is one. */
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

/** The corner the toasts live in, and the two regions that read them out. */
export function ToastRegion({ toasts }: { toasts: readonly ToastItem[] }) {
  // Escape puts every toast away, unless a dialog is open: there Escape is
  // the dialog's, and closing it must not also clear what the page said. The
  // listener reads the toasts through a ref, so it is added once while any
  // are up rather than again on every render.
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

  // The stack's height, for the rail (`[data-rail]`) and the page's end
  // (`[data-toast-room]`) to make room by. It is written on those two alone,
  // never on the root: a custom property there
  // is inherited by every row of every card, and restyling the whole review
  // for one number was the longest task on the page.
  const stack = useRef<HTMLElement>(null);
  const [space, setSpace] = useState(0);
  useEffect(() => {
    const node = stack.current;
    if (!(shown && node)) {
      setSpace(0);
      return;
    }
    // From the stack's top to the bottom of the screen, which takes in the
    // gap under it, the home indicator's inset included. The layout
    // viewport's height, not `innerHeight`, which pinch-zoom shrinks while
    // the fixed stack stays put.
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
      // A toast whose retry is running says "Retrying." instead, and its
      // message comes back as a new node, and is said again, if it fails.
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
