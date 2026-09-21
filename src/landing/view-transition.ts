import { flushSync } from 'react-dom';

// The update is flushed synchronously inside the callback: otherwise React
// still holds it at the second snapshot and the page animates to itself.
interface Transition {
  ready: Promise<void>;
  finished: Promise<void>;
}

type Transitional = Document & {
  startViewTransition?: (update: () => void) => Transition;
};

const SHIFT = '--nav-shift';
const TRAVEL = '--nav-travel';

/** Which transition owns the copied distance; a later one takes it over. */
let pinned = 0;

export function switchView(update: () => void): void {
  const doc: Transitional = document;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still || !doc.startViewTransition) {
    update();
    return;
  }
  // The distance is copied once, here, because the keyframes re-read it every
  // frame: left pointing at the live direction, a click or a traversal
  // landing mid-flight would snap the slide. Nothing else writes this copy,
  // and it is dropped when the animation it belongs to is over.
  const root = document.documentElement;
  const mine = ++pinned;
  root.style.setProperty(
    SHIFT,
    getComputedStyle(root).getPropertyValue(TRAVEL).trim() || '0px',
  );
  const transition = doc.startViewTransition(() => {
    try {
      flushSync(update);
    } catch (error) {
      // Rethrown outside the transition, or the bug surfaces only as two
      // rejected promises wrapping the stack.
      queueMicrotask(() => {
        throw error;
      });
    }
  });
  // A skipped transition (hidden tab, a second one on top) rejects both
  // promises; each must be caught, or the other is reported as unhandled.
  const skipped = () => {
    /* The state change already happened. */
  };
  transition.ready.catch(skipped);
  // A transition skipped by a second one starting on top must leave that
  // one's copy alone.
  const done = () => {
    if (mine !== pinned) {
      return;
    }
    root.style.removeProperty(SHIFT);
    delete root.dataset.nav;
  };
  transition.finished.then(done, () => {
    skipped();
    done();
  });
}
