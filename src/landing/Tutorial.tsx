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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { describePullRequestError } from '@/src/pull-request/errors';
import { useReviewControls, useReviewView } from '@/src/review/ReviewProvider';
import { SITE } from '@/src/site/site';

// `block`, not `swap`: a swap redraws the sentence from a fallback, and the
// bubble must not change shape under the reader. The file is tiny and preloaded.
const pixel = Press_Start_2P({
  display: 'block',
  subsets: ['latin'],
  weight: '400',
});

// Plain ASCII: the pixel face carries Latin only. No "every file": prose is
// never judged, and a pull request can hold more files than one review takes.
const LINES: readonly ReactNode[] = [
  <>
    Quack. This page reviews code against Uncle Bob's{' '}
    <a
      className="rounded-sm text-bubble-ink underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-bubble-ink focus-visible:outline-offset-2"
      href={SITE.book}
      rel="noopener noreferrer"
      target="_blank"
    >
      Clean Code
    </a>
    .
  </>,
  'The code is judged file by file against the book, then reviewed in plain words.',
  'Try one of the examples below, or paste a pull request address into the field.',
];

const LAST = LINES.length - 1;

interface Tutorial {
  line: ReactNode | null;
  /** False once there is nothing left to advance, so the duck stops being a button. */
  canAdvance: boolean;
  step: number;
  next: () => void;
  nudging: boolean;
  /** Where focus goes when the last press removes both buttons. */
  focusTarget: RefObject<HTMLParagraphElement | null>;
}

const TutorialContext = createContext<Tutorial | null>(null);

const HOOK = 'useTutorial';

function useTutorial(): Tutorial {
  const value = useContext(TutorialContext);

  if (!value) {
    throw new Error(`${HOOK} must be used inside <TutorialProvider>`);
  }

  return value;
}

/**
 * No storage: the greeting runs on every visit, and `over` lasts one page load.
 * Set during render, not in an effect: an effect lands a frame after the
 * review is on screen, with the examples still ringed.
 */
export function TutorialProvider({ children }: { children: ReactNode }) {
  const { open, prError } = useReviewView();
  const [step, setStep] = useState(0);
  const [over, setOver] = useState(false);
  const focusTarget = useRef<HTMLParagraphElement>(null);

  if (open && !over) {
    setOver(true);
  }

  const next = useCallback(() => {
    setStep((current) => Math.min(current + 1, LAST));
  }, []);

  const showing = !(open || over);
  // A refused pull request speaks instead; the greeting resumes after it.
  const speaking = showing && prError === null;

  const value = useMemo<Tutorial>(
    () => ({
      canAdvance: speaking && step < LAST,
      focusTarget,
      line: speaking ? (LINES[step] ?? null) : null,
      next,
      nudging: speaking && step === LAST,
      step,
    }),
    [speaking, step, next],
  );

  return (
    <TutorialContext.Provider value={value}>
      {children}
    </TutorialContext.Provider>
  );
}

/**
 * A real button only while there is more to say. It adds no box: the
 * `view-transition-name` sits on its parent, and padding would change the size
 * the morph starts from.
 */
export function TutorialDuck({ children }: { children: ReactNode }) {
  const { canAdvance, next, focusTarget, step } = useTutorial();

  const advance = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      keepFocus(event.currentTarget, step, focusTarget);
      next();
    },
    [next, focusTarget, step],
  );

  if (!canAdvance) {
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

const FOOT_TAPS = '/ducky-foot-taps.webp';

// Module state: the duck remounts on the way home and must not decode again.
let footTapsReady: Promise<void> | null = null;

const IDLE_AT_MOST_MS = 2000;
/** Where `requestIdleCallback` is missing. */
const IDLE_STAND_IN_MS = 200;

/**
 * Skipped under reduced motion (the still shows instead; 700 KB for nothing) and
 * Save-Data. Otherwise deferred to idle: the wink is already on screen.
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
 * An effect can run before the first frame is presented, so it waits for the
 * FCP entry; two animation frames stand in where paint timing is missing.
 */
function afterFirstPaint(then: () => void): () => void {
  const painted = () =>
    performance.getEntriesByName('first-contentful-paint').length > 0;

  if (painted()) {
    then();

    return () => undefined;
  }

  if (
    typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes?.includes('paint')
  ) {
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

/** Both animations are this long, so switches land on whole loops. */
const LOOP_MS = 4800;
const WINK_LOOPS = 1;
const FOOT_TAP_LOOPS = 2;

type DuckLoop = 'foot-taps' | 'wink';

/**
 * Its own clock, not the bubbles': tied to them the wink ends after two lines.
 * No timer until the foot taps are decoded, so none under reduced motion.
 */
function useDuckLoop(): DuckLoop {
  const ready = useFootTaps();
  const [loop, setLoop] = useState<DuckLoop>('wink');

  useEffect(() => {
    if (!ready) {
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const show = (next: DuckLoop) => {
      setLoop(next);
      const loops = next === 'wink' ? WINK_LOOPS : FOOT_TAP_LOOPS;

      timer = setTimeout(
        () => show(next === 'wink' ? 'foot-taps' : 'wink'),
        loops * LOOP_MS,
      );
    };

    // The wink has been playing since the page painted; let it finish.
    timer = setTimeout(() => show('foot-taps'), WINK_LOOPS * LOOP_MS);

    return () => clearTimeout(timer);
  }, [ready]);

  return ready ? loop : 'wink';
}

/**
 * Both loops are cut from one canvas, so switching is one `src`. Unoptimized:
 * the optimiser keeps only an animated image's first frame.
 */
export function TutorialDuckPicture() {
  const tapping = useDuckLoop() === 'foot-taps';

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
        // LCP. Not `preload`: inside `picture` that would hint only one source.
        fetchPriority="high"
        height={480}
        loading="eager"
        src={tapping ? FOOT_TAPS : '/ducky-wink.webp'}
        unoptimized={true}
        width={480}
      />
    </picture>
  );
}

// Palette tokens rather than `dark:`, so the bubble follows the chosen theme,
// not the OS one: always the page's opposite.
const BUBBLE = 'bg-bubble text-bubble-ink';

// Three lines of duck type (every refusal fits in three at 375px), the buttons
// and the padding.
const ERROR_BUBBLE_ROOM = 'max-lg:min-h-[103px]';

/**
 * Holds the bubble's height from fetch through a refusal, so a shorter refusal
 * does not pull the field up. Measured before paint.
 */
function useBubbleFloor(fetching: boolean, prError: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    if (fetching && ref.current) {
      setHeight(ref.current.offsetHeight);
    } else if (!(fetching || prError)) {
      setHeight(0);
    }
  }, [fetching, prError]);

  return { height, ref };
}

const PIXEL_BUTTON = `${pixel.className} inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-end rounded-sm px-1 text-[8px]! text-bubble-ink [font-variant-ligatures:none]! underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-bubble-ink focus-visible:outline-offset-2 aria-disabled:cursor-default aria-disabled:no-underline`;

/**
 * A polite live region rather than aria-hidden: the duck is a labelled button,
 * and its only effect must reach a screen reader. The press that reaches the
 * last sentence removes both buttons, so focus moves to the sentence.
 */
export function TutorialBubble() {
  const { line, canAdvance, next, focusTarget, step } = useTutorial();
  const { prError } = useReviewView();
  const { fetching } = useReviewControls();
  const floor = useBubbleFloor(fetching, prError);

  const advance = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      keepFocus(event.currentTarget, step, focusTarget);
      next();
    },
    [next, focusTarget, step],
  );

  if (!(line || prError)) {
    // On a phone a refusal bubble sits in the flow above the field; hold its
    // room from the press on so the answer does not push the field down.
    return fetching ? (
      <div
        aria-hidden="true"
        className={`invisible mt-3 w-full max-w-[22rem] lg:hidden ${ERROR_BUBBLE_ROOM}`}
        data-tutorial="room"
      />
    ) : null;
  }

  return (
    <div
      className={`relative mt-3 flex w-full max-w-[22rem] flex-col justify-between rounded-md px-3 py-2.5 lg:absolute lg:top-1/2 lg:left-[calc(50%+8.75rem)] lg:mt-0 lg:w-80 lg:-translate-y-1/2 ${prError ? ERROR_BUBBLE_ROOM : ''} ${BUBBLE}`}
      data-tutorial={prError ? 'error' : 'bubble'}
      ref={floor.ref}
      style={floor.height ? { minHeight: floor.height } : undefined}
    >
      {/* Two tails: up at the duck on a phone, left at it from `lg`. */}
      <span
        aria-hidden="true"
        className={`-top-[6px] -ml-[6px] absolute left-1/2 size-3 rotate-45 lg:hidden ${BUBBLE}`}
      />
      <span
        aria-hidden="true"
        className={`-left-[6px] -mt-[6px] absolute top-1/2 hidden size-3 rotate-45 lg:block ${BUBBLE}`}
      />
      {prError ? (
        <DuckTrouble message={prError} />
      ) : (
        <>
          {/* A new node per sentence gives `starting:` a fade to run.
            12px/21px puts the face's 8-pixel grid on whole device pixels at 2x
            (slightly soft at 1x and 3x; 16px was crisp everywhere but loud).
            Ligatures off: the face joins "fi" into one glyph off the grid. */}
          <p
            aria-atomic="true"
            aria-live="polite"
            className={`${pixel.className} text-[12px] leading-[21px] opacity-100 [font-variant-ligatures:none] starting:opacity-0 motion-safe:transition-opacity motion-safe:duration-200`}
            key={step}
            ref={focusTarget}
            tabIndex={-1}
          >
            {line}
          </p>
          {/* Same pixel face as the sentence, arrow included; 8px is the
            face's grid, and the padding keeps a finger-sized target. */}
          {canAdvance ? (
            <div className="-mb-1 flex justify-end">
              <button
                className={PIXEL_BUTTON}
                data-tutorial="next"
                onClick={advance}
                type="button"
              >
                Next &gt;
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * An alert that takes no focus. OK hands focus to the address, the thing to
 * fix.
 */
function DuckTrouble({ message }: { message: string }) {
  const { retryingPr } = useReviewView();
  const { dismissPrError, retryPullRequest } = useReviewControls();
  const trouble = describePullRequestError(message);

  return (
    <>
      <p
        className={`${pixel.className} text-[12px] leading-[21px] opacity-100 [font-variant-ligatures:none] starting:opacity-0 motion-safe:transition-opacity motion-safe:duration-200`}
        data-duck-error={true}
        key={message}
        role="alert"
      >
        {trouble.duckLine}
      </p>
      <div className="-mb-1 flex justify-end gap-3">
        {trouble.retry ? (
          <button
            aria-disabled={retryingPr}
            className={PIXEL_BUTTON}
            data-tutorial="retry"
            // Not `disabled`: a disabled button drops the focus that pressed it.
            onClick={retryingPr ? undefined : retryPullRequest}
            type="button"
          >
            {retryingPr ? 'Retrying...' : 'Retry >'}
          </button>
        ) : null}
        <button
          className={PIXEL_BUTTON}
          data-tutorial="dismiss"
          onClick={(event) => {
            const pressed = document.activeElement === event.currentTarget;

            dismissPrError();
            if (pressed) {
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLInputElement>('[data-pr-repo]')
                  ?.focus(),
              );
            }
          }}
          type="button"
        >
          OK
        </button>
      </div>
    </>
  );
}

// The ring is always drawn and only its colour changes, so the row never shifts.
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

// Only the step before the last: that press removes the button it came from.
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
