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
  transition.finished.catch(skipped);
}
