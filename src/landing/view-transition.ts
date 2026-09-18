import { flushSync } from 'react-dom';

/**
 * Change the page from one view to the other, animated where the browser can
 * do it and where the reader has not asked it not to.
 *
 * The native View Transitions API needs the old and the new DOM in the same
 * frame, so the update has to be flushed synchronously inside the callback —
 * React would otherwise still be holding it when the browser takes the second
 * snapshot, and the transition would animate a page to itself. Everything else
 * is a guard: a browser without the API, or a reader with reduced motion, gets
 * the same state change with no animation around it.
 */
interface Transition {
  /** Rejects when the browser skipped the animation. */
  ready: Promise<void>;
  /** Rejects for the same reasons, one frame later. */
  finished: Promise<void>;
}

type Transitional = Document & {
  startViewTransition?: (update: () => void) => Transition;
};

export function switchView(update: () => void): void {
  const doc: Transitional = document;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still || !doc.startViewTransition) {
    update();
    return;
  }
  const transition = doc.startViewTransition(() => {
    try {
      flushSync(update);
    } catch (error) {
      // A state update that threw is a bug, and a transition is the worst
      // place to hear about one: it would come back as two rejected promises
      // with the stack wrapped in them. Report it once, as the error it is,
      // where the browser's own handler can see it.
      queueMicrotask(() => {
        throw error;
      });
    }
  });
  // A transition the browser skipped — a hidden tab, a second one started on
  // top of this one — rejects both of these. The page has changed either way,
  // and an animation nobody saw is not something to report. Both are caught
  // and not only the first: an unhandled rejection is reported even when its
  // twin was handled.
  const skipped = () => {
    /* Nothing to do: the state change already happened. */
  };
  transition.ready.catch(skipped);
  transition.finished.catch(skipped);
}
