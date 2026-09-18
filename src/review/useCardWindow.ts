'use client';

import {
  type RefObject,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';

/**
 * How many cards a review draws in full straight away — on the server, and so
 * in the first paint. Past this a card is its header and a space the size of
 * its body until the reader comes near it: a fifty-file pull request drawn in
 * full was a megabyte and a half of HTML and twenty thousand elements, almost
 * none of it on screen.
 */
const EAGER_CARDS = 10;

/**
 * How close a card has to come before it is drawn: a couple of phone screens
 * above and below, so a reader scrolling at an ordinary pace meets drawn
 * cards rather than blanks.
 */
const NEAR_MARGIN = '1600px 0px';

/**
 * How long the page has to stop scrolling before a jump from the file list is
 * over, where the browser does not say so itself with `scrollend`.
 */
const SCROLL_SETTLE_MS = 200;

/** Registers a card that is not drawn yet; returns how to stop watching it. */
export type WatchCard = (element: Element, path: string) => () => void;

/**
 * Which cards past the first few are drawn, and the one observer that decides.
 *
 * A card, once drawn, stays drawn: its state is the reader's (a folded
 * findings list, an edit in progress, a caret), and taking it away as it
 * scrolls off would lose that and redo the work on the way back.
 *
 * A jump from the file list draws its card at once and scrolls there. The
 * cards it passes on the way are left alone until the scroll is over: drawn
 * mid-flight they would change height above the card being scrolled to and
 * move it out from under the scroll. Once it has settled, whatever is near is
 * drawn as usual, and `KeepPlace` holds the card where the scroll left it.
 *
 * Cmd/Ctrl+F draws every card that is left, before the browser's find bar
 * opens: find-in-page searches the document, and a card that is only a header
 * and a space has no code in it to find. The keystroke itself is left alone,
 * so the find bar opens as it always does.
 */
export function useCardWindow(reviewId: string, paths: readonly string[]) {
  const [drawn, setDrawn] = useState<Readonly<Record<string, true>>>({});
  // Another review is another set of cards; reset in the render that carries
  // it rather than an effect a frame later.
  const [drawnFor, setDrawnFor] = useState(reviewId);
  if (drawnFor !== reviewId) {
    setDrawnFor(reviewId);
    setDrawn({});
  }

  /** Paths of undrawn cards inside the margin right now. */
  const nearRef = useRef(new Set<string>());
  const pathsRef = useRef(new Map<Element, string>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const jumpingRef = useRef(false);

  const drawNear = useCallback(() => {
    if (jumpingRef.current || !nearRef.current.size) {
      return;
    }
    const near = [...nearRef.current];
    // A transition, so drawing a long card yields to the scroll that
    // brought it near instead of holding up the next frame.
    startTransition(() => {
      setDrawn((current) =>
        near.every((path) => current[path])
          ? current
          : {
              ...current,
              ...Object.fromEntries(near.map((path) => [path, true as const])),
            },
      );
    });
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const path = pathsRef.current.get(entry.target);
          if (path === undefined) {
            continue;
          }
          if (entry.isIntersecting) {
            nearRef.current.add(path);
          } else {
            nearRef.current.delete(path);
          }
        }
        drawNear();
      },
      { rootMargin: NEAR_MARGIN },
    );
    observerRef.current = observer;
    for (const element of pathsRef.current.keys()) {
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [drawNear]);

  const watch: WatchCard = useCallback((element, path) => {
    pathsRef.current.set(element, path);
    observerRef.current?.observe(element);
    return () => {
      pathsRef.current.delete(element);
      nearRef.current.delete(path);
      observerRef.current?.unobserve(element);
    };
  }, []);

  /**
   * Draw one card now, for a jump to it, and hold every other card as it is
   * until the scroll that follows is over. The caller scrolls; this only has
   * to know when that has stopped.
   */
  const jumpTo = useCallback(
    (path: string) => {
      jumpingRef.current = true;
      setDrawn((current) =>
        current[path] ? current : { ...current, [path]: true },
      );
      let timer = 0;
      const done = () => {
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('scrollend', done);
        window.clearTimeout(timer);
        jumpingRef.current = false;
        drawNear();
      };
      function onScroll() {
        window.clearTimeout(timer);
        timer = window.setTimeout(done, SCROLL_SETTLE_MS);
      }
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('scrollend', done);
      // A card already in place is a jump that never scrolls.
      timer = window.setTimeout(done, SCROLL_SETTLE_MS);
    },
    [drawNear],
  );

  // Drawn synchronously, inside the keystroke: the find bar opens as soon as
  // the key is handled, and a search typed into it must already see the code.
  const pathsNowRef = useRef(paths);
  pathsNowRef.current = paths;
  useEffect(() => {
    // The physical F key, whatever the layout calls it, with the platform's
    // own modifier: Cmd on a Mac, where Ctrl+F moves the caret in an editor,
    // and Ctrl everywhere else.
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    function onKeyDown(event: KeyboardEvent) {
      const modifier = mac ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || event.code !== 'KeyF') {
        return;
      }
      const all = pathsNowRef.current;
      flushSync(() => {
        setDrawn((current) =>
          all.every((path) => current[path])
            ? current
            : Object.fromEntries(all.map((path) => [path, true as const])),
        );
      });
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  const isDrawn = useCallback(
    (index: number, path: string) =>
      index < EAGER_CARDS || drawn[path] === true,
    [drawn],
  );

  return { drawn, isDrawn, jumpTo, watch };
}

/**
 * Whether an element is on screen at all, for the order cards are coloured
 * in. One observer for every card that asks.
 *
 * A ref rather than state: it is read when the worker is free to take its next
 * file, and nothing on screen depends on it, so a card scrolling in and out of
 * view must not re-render the thousands of spans in its code to say so.
 */
const onScreen = new Map<Element, RefObject<boolean>>();
let screenObserver: IntersectionObserver | null = null;

export function useOnScreen(
  ref: RefObject<Element | null>,
): RefObject<boolean> {
  const visible = useRef(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    screenObserver ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const flag = onScreen.get(entry.target);
        if (flag) {
          flag.current = entry.isIntersecting;
        }
      }
    });
    onScreen.set(element, visible);
    screenObserver.observe(element);
    return () => {
      onScreen.delete(element);
      screenObserver?.unobserve(element);
    };
  }, [ref]);
  return visible;
}
