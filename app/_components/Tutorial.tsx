'use client';

import { ChevronRight } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

import { QUESTION_COUNT } from '@/agent/lib/questions';

import { useReviewView } from './ReviewProvider';

/**
 * What the duck says when you arrive.
 *
 * Three sentences: what the page is, what it does to a file, and what to do
 * next. They are a greeting rather than a manual — the field below them
 * already says what it wants, and the questions have a page of their own — so
 * the sequence is over in two clicks and never asks to be dismissed.
 *
 * The count is read from the question list rather than typed here, so the
 * greeting cannot fall out of step with the thing it is describing. Every
 * claim in it is one the FAQ already makes: one file at a time, that many
 * questions, and a model whose answers are numbers rather than sentences.
 */
const LINES: readonly string[] = [
  "Hello. This page reviews code against Robert C. Martin's Clean Code.",
  `Each file is put to ${QUESTION_COUNT} questions, answered by a model that writes no prose.`,
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
      className="relative mt-3 w-full max-w-[22rem] rounded-md border border-line bg-surface px-3 py-2.5 lg:absolute lg:top-1/2 lg:left-[calc(50%+8.75rem)] lg:mt-0 lg:w-64 lg:-translate-y-1/2"
      data-tutorial="bubble"
    >
      {/* The tail, twice: it points up at the duck standing above it on a
          phone, and left at the duck standing beside it once there is room.
          A square turned 45 degrees with two of its four borders drawn, so the
          bubble's own outline carries on around the point. */}
      <span
        aria-hidden="true"
        className="-top-[6px] -ml-[6px] absolute left-1/2 size-3 rotate-45 border-line border-t border-l bg-surface lg:hidden"
      />
      <span
        aria-hidden="true"
        className="-left-[6px] -mt-[6px] absolute top-1/2 hidden size-3 rotate-45 border-line border-b border-l bg-surface lg:block"
      />
      {/* A new node per sentence, so the browser has something to start the
          fade from. `starting:` is the whole animation: no keyframes, and
          under reduced motion the transition is not declared at all, so the
          sentence simply appears. */}
      <p
        aria-atomic="true"
        aria-live="polite"
        className="text-[13px] text-ink leading-relaxed opacity-100 starting:opacity-0 motion-safe:transition-opacity motion-safe:duration-200"
        key={step}
        ref={said}
        tabIndex={-1}
      >
        {line}
      </p>
      {more ? (
        <button
          className="-mb-1 mt-1 inline-flex min-h-8 cursor-pointer items-center gap-0.5 text-[12px] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
          data-tutorial="next"
          onClick={advance}
          type="button"
        >
          Next
          <ChevronRight aria-hidden="true" size={13} strokeWidth={1.75} />
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
