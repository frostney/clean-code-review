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

/**
 * What comes back: first word that the file is being tokenised — everything
 * it needed has been fetched — then its lines, or null when its grammar would
 * not load. `unavailable` is the worker saying shiki itself would not start,
 * which is the worker's failure rather than the file's.
 */
export type HighlightReply =
  | { id: number; tokenising: true }
  | { id: number; lines: Token[][] | null }
  | { id: number; unavailable: true };

interface Job {
  request: HighlightRequest;
  /** On screen, so it goes before anything that is only rendered. */
  urgent: () => boolean;
  done: (lines: Token[][] | null) => void;
  /** The card no longer wants it. */
  cancelled: boolean;
  /** The worker has everything it needs and is inside shiki with this file. */
  tokenising: boolean;
  /** Workers that failed to get this file started. */
  loadFailures: number;
}

/**
 * How many workers may fail to get one file started before the file is left
 * plain. A worker that cannot load is the connection's fault, not the
 * file's, but a file that is always the one in hand when it happens should
 * not keep the rest of the queue waiting on it.
 */
const LOAD_TRIES = 3;

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

/**
 * How long one file may take to tokenise, counted from the worker saying it
 * has started — after the engine, the themes and the file's grammar have
 * arrived, so a slow connection is never mistaken for a slow file. The
 * slowest real file measured, at a phone's CPU, took a tenth of a second; a
 * file still going after five has hit a grammar's pathological case and would
 * hold every card behind it forever.
 */
const FILE_TIMEOUT_MS = 5_000;
/**
 * How long the worker may take to get a file started: to load itself, shiki
 * and the file's grammar. A connection that has not managed that in a minute
 * has stalled, and the worker is started again after the usual pause; it is
 * never the file's fault, so the file is tried again too.
 */
const LOAD_TIMEOUT_MS = 60_000;
let watchdog: ReturnType<typeof setTimeout> | null = null;

function stopWatchdog() {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

/**
 * Files that ran out of time, so an edit or a theme switch does not hand the
 * same file back to a fresh worker to hang it again. Kept short: it only has
 * to outlive the review they were in.
 */
const HUNG_KEEP = 20;
const hung: string[] = [];

function hungKey({ code, lang }: HighlightRequest): string {
  return `${lang}\u0000${code}`;
}

/**
 * The worker would not start: the chunk failed to arrive, or the browser
 * refused it. Every card stays plain meanwhile, which is what a card shows
 * before its colours arrive anyway, and the worker is tried again after a
 * pause that doubles each time, up to a minute, while there is anything to
 * colour. A worker that answers resets the count.
 */
const RETRY_FIRST_MS = 2_000;
const RETRY_MOST_MS = 60_000;
let failures = 0;
let retryAt = 0;
/** A retry is already scheduled, so a second wait does not stack another. */
let retryPending = false;

function drop(w: Worker) {
  w.terminate();
  if (worker === w) {
    worker = null;
  }
}

/**
 * The worker failed before it got to the file it had — it would not load, or
 * shiki, the themes or the grammar would not arrive: wait, then try a new
 * one. The file goes to the back of the queue, so the files behind it are not
 * held up by it, and after `LOAD_TRIES` workers it is left plain.
 */
function failed(w: Worker) {
  drop(w);
  const job = running;
  running = null;
  if (job && !job.cancelled) {
    job.loadFailures += 1;
    if (job.loadFailures < LOAD_TRIES) {
      queue.push(job);
    } else {
      job.done(null);
    }
  }
  stopWatchdog();
  failures += 1;
  retryAt =
    Date.now() + Math.min(RETRY_MOST_MS, RETRY_FIRST_MS * 2 ** (failures - 1));
  pump();
}

function spawn(): Worker | null {
  if (worker) {
    return worker;
  }
  const wait = retryAt - Date.now();
  if (wait > 0) {
    if (!retryPending) {
      retryPending = true;
      setTimeout(() => {
        retryPending = false;
        pump();
      }, wait);
    }
    return null;
  }
  let w: Worker;
  try {
    w = new Worker(new URL('./highlight.worker.ts', import.meta.url), {
      type: 'module',
    });
  } catch {
    failures += 1;
    retryAt =
      Date.now() +
      Math.min(RETRY_MOST_MS, RETRY_FIRST_MS * 2 ** (failures - 1));
    return spawn();
  }
  worker = w;
  w.addEventListener('message', (event: MessageEvent<HighlightReply>) => {
    const reply = event.data;
    if (worker !== w || running?.request.id !== reply.id) {
      return;
    }
    stopWatchdog();
    if ('unavailable' in reply) {
      failed(w);
      return;
    }
    failures = 0;
    if ('tokenising' in reply) {
      running.tokenising = true;
      watchdog = setTimeout(() => timedOut(w), FILE_TIMEOUT_MS);
      return;
    }
    const job = running;
    running = null;
    job.done(reply.lines);
    pump();
  });
  // A worker that dies inside shiki died of the file it had — out of memory
  // on a pathological file, say — and would die of it again: that file is
  // treated as one that ran out of time. Dying any earlier is the worker's.
  w.addEventListener('error', () => {
    if (worker !== w) {
      return;
    }
    stopWatchdog();
    if (running?.tokenising) {
      timedOut(w);
    } else {
      failed(w);
    }
  });
  return w;
}

/**
 * The file in the worker ran out of time, or took the worker down with it.
 * The worker cannot be interrupted mid-file, so it is thrown away with the
 * grammars it had loaded; the file stays plain — and so does any copy of it
 * still waiting, a theme switch's say — and the next one goes to a new
 * worker.
 */
function timedOut(w: Worker) {
  watchdog = null;
  const job = running;
  running = null;
  drop(w);
  if (job) {
    const key = hungKey(job.request);
    hung.push(key);
    if (hung.length > HUNG_KEEP) {
      hung.shift();
    }
    job.done(null);
    for (const waiting of queue.filter((q) => hungKey(q.request) === key)) {
      queue.splice(queue.indexOf(waiting), 1);
      waiting.done(null);
    }
  }
  pump();
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
  watchdog = setTimeout(() => failed(w), LOAD_TIMEOUT_MS);
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
    cancelled: false,
    done,
    loadFailures: 0,
    request: { code, id: nextId++, lang, theme },
    tokenising: false,
    urgent,
  };
  if (hung.includes(hungKey(job.request))) {
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
      job.cancelled = true;
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
