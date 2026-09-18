'use client';

import { Press_Start_2P } from 'next/font/google';
import Image from 'next/image';
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useReviewView } from './ReviewProvider';

/**
 * The duck's voice: an 8-pixel-grid face, loaded here and applied to the
 * sentence alone, so nothing else on the page is set in it.
 *
 * `block` rather than the `swap` the page's own faces use. A swap paints the
 * sentence in a fallback first and then redraws it in pixels, and a bubble
 * whose letters change shape and width under the reader is exactly the jump
 * this face must not make. The file is a few kilobytes and preloaded from the
 * head, so the block is usually over before the first paint; if it is not, the
 * sentence is late rather than wrong, and it fades in either way.
 */
const pixel = Press_Start_2P({
  display: 'block',
  subsets: ['latin'],
  weight: '400',
});

/**
 * What the duck says when you arrive.
 *
 * Three sentences: what the page is, what it does to a file, and what to do
 * next. They are a greeting rather than a manual — the field below them
 * already says what it wants, and the questions have a page of their own — so
 * the sequence is over in two clicks and never asks to be dismissed.
 *
 * No count of questions: how many there are is a fact the FAQ answers when
 * asked, not something to sell with. "Every code file" and never "every file",
 * because prose in a change is shown and never judged. The copy is plain ASCII
 * on purpose, since the pixel face below carries Latin and nothing more.
 */
const LINES: readonly string[] = [
  "Hello. This page reviews code against Robert C. Martin's Clean Code.",
  'Every code file is judged against the book, then reviewed in plain words.',
  'Try one of the examples below, or paste a pull request address into the field.',
];

const LAST = LINES.length - 1;

interface Tutorial {
  /** The sentence on screen, or null once the greeting is over. */
  line: string | null;
  /**
   * The greeting is running and has another sentence after this one, so there
   * is something for a click to do. False the moment it is over, which is what
   * keeps a duck nobody can advance from staying a button.
   */
  more: boolean;
  /** Which sentence is showing. Only the affordances need this. */
  step: number;
  next: () => void;
  /** The last sentence is up, and the examples are what it is pointing at. */
  nudging: boolean;
  /** The sentence itself, which is where focus goes when the buttons leave. */
  said: RefObject<HTMLParagraphElement | null>;
}

const TutorialContext = createContext<Tutorial | null>(null);

/** Spelled once, so the error below reads as a sentence rather than a blob. */
const HOOK = 'useTutorial';

function useTutorial(): Tutorial {
  const value = useContext(TutorialContext);
  if (!value) {
    throw new Error(`${HOOK} must be used inside <TutorialProvider>`);
  }
  return value;
}

/**
 * The greeting's state, which is the whole of its memory.
 *
 * It runs on every visit, so there is nothing to remember between them: no
 * storage is read and none is written, and a reload is a fresh hello. What
 * does have to be remembered is within one page load — a reader who has opened
 * a review has been introduced, and going home afterwards must not introduce
 * them again — and that is `over`, which lives here and dies with the tab.
 *
 * Setting it while rendering rather than in an effect is deliberate: the
 * examples keep their ring until the state that hides it lands, and an effect
 * lands a frame after the review is already on screen.
 */
export function TutorialProvider({ children }: { children: ReactNode }) {
  const { open } = useReviewView();
  const [step, setStep] = useState(0);
  const [over, setOver] = useState(false);
  const said = useRef<HTMLParagraphElement>(null);

  if (open && !over) {
    setOver(true);
  }

  const next = useCallback(() => {
    setStep((current) => Math.min(current + 1, LAST));
  }, []);

  const showing = !(open || over);

  const value = useMemo<Tutorial>(
    () => ({
      line: showing ? (LINES[step] ?? null) : null,
      more: showing && step < LAST,
      next,
      nudging: showing && step === LAST,
      said,
      step,
    }),
    [showing, step, next],
  );

  return (
    <TutorialContext.Provider value={value}>
      {children}
    </TutorialContext.Provider>
  );
}

/**
 * The duck, as the thing you click to hear the rest.
 *
 * It is the obvious target — it is the largest thing on the page and it is the
 * one talking — so it is a real button with a name that says what pressing it
 * does, rather than a click handler on a picture. Once there is nothing left
 * to say — the last sentence is up, or a review has ended the greeting for
 * this page load — the button is gone and the duck is a picture again: a
 * control that does nothing is worse than no control.
 *
 * The button adds no box of its own. The `view-transition-name` that turns
 * this duck into the small one beside the field sits on the element outside
 * it, and a wrapper with padding would change the size the browser morphs
 * from.
 */
export function TutorialDuck({ children }: { children: ReactNode }) {
  const { more, next, said, step } = useTutorial();

  const advance = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      keepFocus(event.currentTarget, step, said);
      next();
    },
    [next, said, step],
  );

  if (!more) {
    return children;
  }

  return (
    <button
      aria-label="Show the next line"
      className="inline-flex cursor-pointer rounded-md"
      data-tutorial="duck"
      onClick={advance}
      title="Show the next line"
      type="button"
    >
      {children}
    </button>
  );
}

/** The duck waiting for a pick: a loop of foot taps, fetched late. */
const FOOT_TAPS = '/ducky-foot-taps.webp';

/**
 * Whether the foot taps are downloaded and decoded, for this page load.
 *
 * Module state rather than component state, because the landing duck unmounts
 * when a review opens and mounts again on the way home, and a duck that has
 * already been tapping its feet should not wink once more while the file it
 * already has is decoded a second time. It is memory, not storage: a reload
 * starts it over.
 */
let footTapsReady: Promise<void> | null = null;

/** However busy the page is, the fetch starts within this long of painting. */
const IDLE_AT_MOST_MS = 2000;
/** Where there is no idle callback, how long after painting to start. */
const IDLE_STAND_IN_MS = 200;

/**
 * Fetch and decode the foot taps once the page has painted, if it should.
 *
 * Never under reduced motion, where the duck is the still and an animation
 * nobody sees is 700 KB for nothing, and never for a reader who has asked
 * their browser to save data. Otherwise not until the browser is idle: the
 * file is the largest thing on the landing view, and the wink it replaces is
 * already on screen, so nothing is waiting for it.
 */
function useFootTaps(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      (navigator as Navigator & { connection?: { saveData?: boolean } })
        .connection?.saveData
    ) {
      return;
    }

    let live = true;
    const settle = () => {
      if (live) {
        setReady(true);
      }
    };
    if (footTapsReady !== null) {
      footTapsReady.then(settle, () => undefined);
      return () => {
        live = false;
      };
    }

    const start = () => {
      const image = new window.Image();
      image.src = FOOT_TAPS;
      footTapsReady = image.decode();
      footTapsReady.then(settle, () => {
        footTapsReady = null;
      });
    };
    const idle = typeof window.requestIdleCallback === 'function';
    let handle = 0;
    const stopWaiting = afterFirstPaint(() => {
      handle = idle
        ? window.requestIdleCallback(start, { timeout: IDLE_AT_MOST_MS })
        : window.setTimeout(start, IDLE_STAND_IN_MS);
    });

    return () => {
      live = false;
      stopWaiting();
      if (idle) {
        window.cancelIdleCallback(handle);
      } else {
        window.clearTimeout(handle);
      }
    };
  }, []);

  return ready;
}

/**
 * Run `then` once the page has put something on screen, and return a way to
 * stop waiting.
 *
 * An effect can run before the first frame is presented, so mounting is not
 * proof of a paint. The browser's own first-contentful-paint entry is, and a
 * tab opened in the background simply reports it later, once it is shown.
 * Where there is no paint timing, two animation frames stand in: the second
 * comes after the first has been drawn.
 */
function afterFirstPaint(then: () => void): () => void {
  const painted = () =>
    performance.getEntriesByName('first-contentful-paint').length > 0;
  if (painted()) {
    then();
    return () => undefined;
  }

  if (!PerformanceObserver.supportedEntryTypes?.includes('paint')) {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(then);
    });
    return () => cancelAnimationFrame(frame);
  }

  const observer = new PerformanceObserver(() => {
    if (painted()) {
      observer.disconnect();
      then();
    }
  });
  observer.observe({ buffered: true, type: 'paint' });
  return () => observer.disconnect();
}

/**
 * The landing duck's artwork: a wink while it is talking, foot taps once it is
 * waiting for you to choose an example.
 *
 * Both loops are cut from the same canvas, so they fill the same box with the
 * bird in the same place, and the change is one `src` on one element. It only
 * happens once the foot taps are decoded, which is why there is never a blank
 * frame between them: until then the wink carries on. `picture` swaps in the
 * matching still for a reader who has asked for less motion, and the foot taps
 * are never fetched for them. Neither loop goes through the optimiser, which
 * keeps an animated image's first frame and drops the rest.
 */
export function TutorialDuckPicture() {
  const { step } = useTutorial();
  const tapping = useFootTaps() && step === LAST;

  return (
    <picture>
      <source
        media="(prefers-reduced-motion: reduce)"
        srcSet="/ducky-still.png"
      />
      <Image
        alt=""
        className="h-44 w-44 sm:h-62 sm:w-62"
        data-duck-loop={tapping ? 'foot-taps' : 'wink'}
        height={480}
        loading="eager"
        src={tapping ? FOOT_TAPS : '/ducky-wink.webp'}
        unoptimized={true}
        width={480}
      />
    </picture>
  );
}

/**
 * The bubble's colours, which are the one place on the page that does not
 * read from the palette: white on black in both themes, so the duck's speech
 * looks the same by day and by night.
 *
 * The edge is the exception that does follow the theme. On the white page a
 * black bubble needs no outline, and on the near-black one it would vanish
 * without one. The ink token is dark in the light theme and light in the dark
 * one, so a border in ink over black is invisible by day and a light hairline
 * by night, with no theme selector written here.
 */
const INK_ON_BLACK = 'border-ink/60 bg-black text-white';

/**
 * What the duck is saying, in a bubble beside it.
 *
 * Exposed to a screen reader rather than hidden from one. Hiding it would be
 * the easy answer — every claim in it is elsewhere on the page — but the duck
 * beside it is a button, and a labelled button whose whole effect is invisible
 * to the reader pressing it is a worse lie than a little repetition. So the
 * sentence is a polite live region: nothing is announced on arrival, because a
 * live region does not announce what it was born with, and each press
 * announces the sentence it produced. Nothing takes focus on its own and
 * nothing loops, so there is no trap to get out of.
 *
 * The exception is the press that reaches the last sentence, which takes both
 * affordances off the page. Focus would fall to the document, so it is put on
 * the sentence instead — the one thing on screen that just changed.
 */
export function TutorialBubble() {
  const { line, more, next, said, step } = useTutorial();

  const advance = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      keepFocus(event.currentTarget, step, said);
      next();
    },
    [next, said, step],
  );

  if (!line) {
    return null;
  }

  return (
    <div
      className={`relative mt-3 w-full max-w-[22rem] rounded-md border px-3 py-2.5 lg:absolute lg:top-1/2 lg:left-[calc(50%+8.75rem)] lg:mt-0 lg:w-80 lg:-translate-y-1/2 ${INK_ON_BLACK}`}
      data-tutorial="bubble"
    >
      {/* The tail, twice: it points up at the duck standing above it on a
          phone, and left at the duck standing beside it once there is room.
          A square turned 45 degrees with two of its four borders drawn, so the
          bubble's own outline carries on around the point. */}
      <span
        aria-hidden="true"
        className={`-top-[6px] -ml-[6px] absolute left-1/2 size-3 rotate-45 border-t border-l lg:hidden ${INK_ON_BLACK}`}
      />
      <span
        aria-hidden="true"
        className={`-left-[6px] -mt-[6px] absolute top-1/2 hidden size-3 rotate-45 border-b border-l lg:block ${INK_ON_BLACK}`}
      />
      {/* A new node per sentence, so the browser has something to start the
          fade from. `starting:` is the whole animation: no keyframes, and
          under reduced motion the transition is not declared at all, so the
          sentence simply appears.
          16px because the face is drawn on an 8-pixel grid: at 16px one of
          its pixels is two CSS pixels, which is a whole number of device
          pixels on a 1x, a 2x and a 3x screen alike, so no edge is ever
          smeared across two. 12px is crisp only at 2x, and 8px is too small
          to read. The glyphs are a full em wide, so the lines are spaced
          generously and the bubble is wider from `lg` up. Ligatures are off:
          the face joins "fi" into one glyph, which breaks the grid. */}
      <p
        aria-atomic="true"
        aria-live="polite"
        className={`${pixel.className} text-[16px] leading-[1.75] opacity-100 [font-variant-ligatures:none] starting:opacity-0 motion-safe:transition-opacity motion-safe:duration-200`}
        key={step}
        ref={said}
        tabIndex={-1}
      >
        {line}
      </p>
      {/* The control is set in the same pixels as the sentence, at the same
          size and for the same reason: it is part of the bubble, and a
          dialogue box in two typefaces reads as two things. The arrow is the
          face's own `>`, not an icon, so it sits on the same grid. */}
      {more ? (
        <button
          className={`${pixel.className} -mb-1 mt-1 inline-flex min-h-8 cursor-pointer items-center rounded-sm text-[16px] text-white [font-variant-ligatures:none] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2`}
          data-tutorial="next"
          onClick={advance}
          type="button"
        >
          Next &gt;
        </button>
      ) : null}
    </div>
  );
}

/**
 * The row of examples, ringed while the sentence that names them is up.
 *
 * A ring rather than a spotlight: nothing is dimmed, nothing is covered and
 * the chips stay exactly where they were, because the reader is meant to click
 * one and not to admire the emphasis. The ring is always drawn and only its
 * colour changes, so the row does not move when it arrives.
 */
export function TutorialSpotlight({ children }: { children: ReactNode }) {
  const { nudging } = useTutorial();

  return (
    <div
      className={`-mx-1.5 mt-1.5 rounded-md px-1.5 py-1 ring-1 motion-safe:transition-shadow motion-safe:duration-200 ${
        nudging ? 'ring-accent/40' : 'ring-transparent'
      }`}
      data-tutorial={nudging ? 'nudge' : undefined}
    >
      {children}
    </div>
  );
}

/**
 * Hold on to focus across the press that removes the thing pressed.
 *
 * Only the step before the last one does this: every other press leaves its
 * button on the page, and moving focus off a control someone is still using is
 * its own kind of rude.
 */
function keepFocus(
  control: HTMLElement,
  step: number,
  target: RefObject<HTMLElement | null>,
): void {
  if (step !== LAST - 1 || document.activeElement !== control) {
    return;
  }
  requestAnimationFrame(() => target.current?.focus());
}
