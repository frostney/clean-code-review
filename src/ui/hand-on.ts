/** A view transition commits its update a frame or two after the press. */
const AT_MOST_MS = 300;
const BETWEEN_MS = 16;

/** Where the page carries on: a selector, or a ref to a node already drawn. */
type Target = string | { readonly current: HTMLElement | null };

function nodeOf(target: Target): HTMLElement | null {
  return typeof target === 'string'
    ? document.querySelector<HTMLElement>(target)
    : target.current;
}

/**
 * A press that removes the button it came from leaves the focus on `<body>`
 * unless it is handed somewhere. `target` is where the page carries on.
 *
 * Tasks, not frames: React has committed the press's DOM by the next frame,
 * but a page the browser is not painting — a hidden tab, a background window —
 * produces no frames at all, so `requestAnimationFrame` may never run and the
 * focus would be dropped exactly where nobody is watching to notice.
 *
 * It waits for the target instead of looking once, because a change made
 * inside a view transition (`switchView`) lands after the browser has taken
 * its first snapshot, so the place the page carries on at does not exist yet
 * at the end of the press. Looking once was right only for a target already on
 * screen, and silently wrong for the rest — a preset chip handed its focus to
 * `<body>` with motion on and to the duck with motion reduced.
 *
 * A background tab clamps `setTimeout` to about a second, so the budget there
 * buys one look rather than nineteen. That is the one case it does not need:
 * a hidden document makes `startViewTransition` skip, its update runs at once,
 * and the target is there on the first look.
 *
 * Monotonic time, because wall clock can step under it. It stops as soon as
 * the focus is somewhere the reader put it, so tabbing on during the wait
 * keeps where they got to, and it keeps looking when a target refuses the
 * focus — `inert`, hidden, disabled — rather than ending on `<body>`.
 */
export function handOn(control: HTMLElement, target: Target): void {
  if (document.activeElement !== control) {
    return;
  }
  const until = performance.now() + AT_MOST_MS;

  const look = () => {
    const active = document.activeElement;

    if (active !== control && active !== document.body) {
      return;
    }
    const place = nodeOf(target);

    place?.focus();
    if (document.activeElement !== place && performance.now() < until) {
      setTimeout(look, BETWEEN_MS);
    }
  };

  setTimeout(look, 0);
}
