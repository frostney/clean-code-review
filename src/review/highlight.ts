'use client';

import {
  type RefObject,
  startTransition,
  useEffect,
  useMemo,
  useState,
} from 'react';

import type { Theme } from '@/src/theme/theme';
import { useTheme } from '@/src/theme/useTheme';

import type { Lang } from './language';

/**
 * One theme per paper, and no third: the page is a review, not a colour
 * scheme. Shiki writes its colours into inline `style` attributes, which is
 * the one part of the page a CSS variable cannot reach — so the theme has to
 * be chosen here and the code re-tokenised when it changes.
 */
const THEMES: Record<Theme, ShikiTheme> = {
  dark: 'github-dark',
  light: 'github-light',
};

type ShikiTheme = 'github-dark' | 'github-light';

/** One piece of a highlighted line: its text, and the colour shiki gave it. */
export interface Token {
  content: string;
  color?: string;
}

/** One line of highlighted code: the tokens shiki produced for it. */
export type TokenLine = readonly Token[];

/** What the page asks the worker for: one file, one language, one theme. */
export interface HighlightRequest {
  id: number;
  code: string;
  lang: Lang;
  theme: ShikiTheme;
}

/** What comes back: the file's lines, or null when its grammar would not load. */
export interface HighlightReply {
  id: number;
  lines: Token[][] | null;
}

interface Job {
  request: HighlightRequest;
  /** On screen, so it goes before anything that is only rendered. */
  urgent: () => boolean;
  done: (lines: Token[][] | null) => void;
}

/**
 * The one worker every card shares, and the queue in front of it.
 *
 * Highlighting a file is the most expensive thing this page does, and a pull
 * request's worth of it in one go was a single three-second task on a phone.
 * In the worker it costs the main thread nothing but the copy of the result;
 * the queue is what decides the order, and it hands the worker one file at a
 * time so that a card scrolled into view jumps ahead of every card that is
 * merely rendered.
 */
let worker: Worker | null = null;
/** Jobs not yet handed to the worker, oldest first. */
const queue: Job[] = [];
/** The job the worker is on, which cannot be recalled. */
let running: Job | null = null;
let nextId = 1;
/** The worker would not start or has died: every card stays plain text. */
let broken = false;

function spawn(): Worker | null {
  if (worker || broken) {
    return worker;
  }
  try {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), {
      type: 'module',
    });
  } catch {
    broken = true;
    return null;
  }
  worker.addEventListener('message', (event: MessageEvent<HighlightReply>) => {
    const job = running;
    running = null;
    if (job && job.request.id === event.data.id) {
      job.done(event.data.lines);
    }
    pump();
  });
  worker.addEventListener('error', () => {
    // Nothing more will come back. What is on screen stays plain, which is
    // what a card showed before its colours arrived anyway.
    broken = true;
    worker = null;
    const orphans = running ? [running, ...queue] : [...queue];
    running = null;
    queue.length = 0;
    for (const job of orphans) {
      job.done(null);
    }
  });
  return worker;
}

/** Hand the worker its next file: the first one on screen, else the oldest. */
function pump() {
  if (running || !queue.length) {
    return;
  }
  const w = spawn();
  if (!w) {
    return;
  }
  const at = Math.max(
    0,
    queue.findIndex((job) => job.urgent()),
  );
  const [job] = queue.splice(at, 1);
  running = job;
  w.postMessage(job.request);
}

/** A file in the queue: what a card holds so it can drop it. */
interface Ticket {
  cancel: () => void;
}

function highlight(
  code: string,
  lang: Lang,
  theme: ShikiTheme,
  urgent: () => boolean,
  done: (lines: Token[][] | null) => void,
): Ticket {
  const job: Job = {
    done,
    request: { code, id: nextId++, lang, theme },
    urgent,
  };
  if (broken) {
    done(null);
    return { cancel: () => undefined };
  }
  queue.push(job);
  pump();
  return {
    cancel() {
      const at = queue.indexOf(job);
      if (at >= 0) {
        queue.splice(at, 1);
      }
      // Already with the worker: let it finish, and drop what it says.
      job.done = () => undefined;
    },
  };
}

/** Every line as one plain token — what a card shows before its colours land. */
function plainLines(code: string): TokenLine[] {
  return code.split('\n').map((line) => (line ? [{ content: line }] : []));
}

/**
 * Tokenise `code` as `lang`. Returns plain lines until the worker has coloured
 * it, so a card never renders empty and never waits on a grammar that is still
 * being fetched. A plain line is the same text on the same line as its
 * coloured one, so the colours arriving moves nothing.
 *
 * `debounceMs` is for the editor: re-tokenising on every keystroke is what
 * makes an overlay editor feel heavy, and 50 ms is below the threshold where
 * the colours look like they lag the caret.
 *
 * `onScreen` says whether the card is in view: a file in view is the next one
 * the worker takes, ahead of every card that is rendered but out of sight.
 *
 * The active theme is a dependency like the code is: switching the page to
 * dark re-tokenises every card, because shiki's colours are inline styles and
 * nothing else can repaint them.
 */
export function useTokens(
  code: string,
  lang: Lang,
  debounceMs = 0,
  onScreen?: RefObject<boolean>,
): TokenLine[] {
  const [lines, setLines] = useState<TokenLine[] | null>(null);
  const [forCode, setForCode] = useState<string | null>(null);
  const theme = useTheme();

  useEffect(() => {
    let ticket: Ticket | null = null;
    const start = () => {
      ticket = highlight(
        code,
        lang,
        THEMES[theme],
        () => onScreen?.current === true,
        (result) => {
          // Drawing a file's colours is a render of every span in it; as a
          // transition it yields to a scroll or a keystroke in between.
          startTransition(() => {
            setLines(result);
            setForCode(code);
          });
        },
      );
    };
    if (debounceMs <= 0) {
      start();
      return () => ticket?.cancel();
    }
    const timer = setTimeout(start, debounceMs);
    return () => {
      clearTimeout(timer);
      ticket?.cancel();
    };
  }, [code, lang, debounceMs, theme, onScreen]);

  const plain = useMemo(() => plainLines(code), [code]);

  // Between a keystroke and the next tokenisation the highlighted layer would
  // otherwise show the previous text under the caret. Plain lines for the new
  // text are wrong in colour for a few frames; stale text is wrong in content.
  return lines && forCode === code ? lines : plain;
}
