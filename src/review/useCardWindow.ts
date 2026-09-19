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
 * Drawn in full on the server. The rest are header plus placeholder until
 * near: a fifty-file pull request drawn in full measured 1.5 MB of HTML and
 * 20,000 elements.
 */
const EAGER_CARDS = 10;

/** A couple of phone screens, so ordinary scrolling meets drawn cards. */
const NEAR_MARGIN = '1600px 0px';

/** Fallback where the browser lacks `scrollend`. */
const SCROLL_SETTLE_MS = 200;

/** Returns an unwatch function. */
export type WatchCard = (element: Element, path: string) => () => void;

/**
 * A drawn card stays drawn: it holds the reader's state (folds, edits, caret).
 *
 * A jump from the file list draws its target at once, but cards it passes are
 * not drawn until the scroll settles: their height change would move the
 * target out from under the scroll. `KeepPlace` then holds the position.
 *
 * Cmd/Ctrl+F draws every remaining card before the find bar opens, since a
 * placeholder has no text to find. The keystroke is not prevented. A search
 * opened another way (e.g. the browser menu) only finds drawn cards.
 */
export function useCardWindow(reviewId: string, paths: readonly string[]) {
  const [drawn, setDrawn] = useState<Readonly<Record<string, true>>>({});
  // Reset during render, not in an effect a frame later.
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
    // Yields to the scroll that brought the card near.
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

  /** The caller scrolls; this only tracks when the scroll has stopped. */
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
      // For a jump that never scrolls.
      timer = window.setTimeout(done, SCROLL_SETTLE_MS);
    },
    [drawNear],
  );

  // flushSync: the find bar opens as soon as the key is handled, and must
  // already see the code.
  const pathsNowRef = useRef(paths);
  pathsNowRef.current = paths;
  useEffect(() => {
    // Matches the browser's own reading of the shortcut: the layout's F (on
    // Dvorak, QWERTY's Y), or the physical F key on non-Latin layouts. Cmd on
    // Mac, where Ctrl+F moves the caret; Ctrl elsewhere.
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    function isF(event: KeyboardEvent): boolean {
      return (
        event.key.toLowerCase() === 'f' ||
        (!/^[a-z]$/i.test(event.key) && event.code === 'KeyF')
      );
    }
    function onKeyDown(event: KeyboardEvent) {
      const modifier = mac ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || !isF(event)) {
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
 * Orders the highlight queue. A ref, not state: nothing rendered depends on
 * it, and a re-render would repaint thousands of code spans.
 */
const onScreenFlags = new Map<Element, RefObject<boolean>>();
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
        const flag = onScreenFlags.get(entry.target);
        if (flag) {
          flag.current = entry.isIntersecting;
        }
      }
    });
    onScreenFlags.set(element, visible);
    screenObserver.observe(element);
    return () => {
      onScreenFlags.delete(element);
      screenObserver?.unobserve(element);
    };
  }, [ref]);
  return visible;
}
