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

// Shiki writes colours as inline styles, which CSS variables cannot reach, so
// the theme is picked here and code is re-tokenised when it changes.
const THEMES: Record<Theme, ShikiTheme> = {
  dark: 'github-dark',
  light: 'github-light',
};

type ShikiTheme = 'github-dark' | 'github-light';

export interface Token {
  content: string;
  color?: string;
}

export type TokenLine = readonly Token[];

export interface HighlightRequest {
  id: number;
  code: string;
  lang: Lang;
  theme: ShikiTheme;
}

/**
 * `tokenising` comes first, once everything the file needs has loaded; the
 * file timeout starts there. `lines: null` means the grammar would not load
 * and the file stays plain. `unavailable` means shiki would not start; the
 * page handles it as a load failure (see `loadFailed`).
 */
export type HighlightReply =
  | { id: number; tokenising: true }
  | { id: number; lines: Token[][] | null }
  | { id: number; unavailable: true };

interface Job {
  request: HighlightRequest;
  urgent: () => boolean;
  done: (lines: Token[][] | null) => void;
  cancelled: boolean;
  /** Loaded and inside shiki: a crash now is the file's fault. */
  tokenising: boolean;
  loadFailures: number;
}

/**
 * Load failures a file may be in hand for before it is left plain. They are
 * usually the connection's fault, but a file that is always in hand when one
 * happens must not hold up the queue.
 */
const LOAD_TRIES = 3;

/**
 * One worker shared by every card, fed one file at a time so a card scrolled
 * into view jumps ahead of off-screen ones. On the main thread, a whole pull
 * request measured as a single 3 s task on a phone.
 */
let worker: Worker | null = null;
const queue: Job[] = [];
/** Already posted to the worker; cannot be recalled. */
let running: Job | null = null;
let nextId = 1;

/**
 * Counted from the `tokenising` reply, so network time is excluded. The
 * slowest real file measured at phone CPU took 0.1 s; one still going after
 * 5 s has hit a grammar's pathological case and would block the queue forever.
 */
const FILE_TIMEOUT_MS = 5_000;
/**
 * For the worker to load itself, shiki and the grammar. On expiry the worker
 * is replaced after the retry pause, and the stall counts toward the file's
 * `LOAD_TRIES`.
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
 * Files that timed out or crashed the worker, so an edit or theme switch does
 * not hang a fresh worker on them again. Short: it only has to outlive one
 * review.
 */
const HUNG_KEEP = 20;
const hung: string[] = [];

function hungKey({ code, lang }: HighlightRequest): string {
  return `${lang}\u0000${code}`;
}

// Backoff between worker restarts: doubles from 2 s up to 1 min, reset by any
// reply other than `unavailable`. Cards stay plain meanwhile.
const RETRY_FIRST_MS = 2_000;
const RETRY_MOST_MS = 60_000;
let failures = 0;
let retryAt = 0;
/** So a second wait does not stack another timer. */
let retryPending = false;

function drop(w: Worker) {
  w.terminate();
  if (worker === w) {
    worker = null;
  }
}

/**
 * The worker failed before tokenising: it crashed while loading, shiki would
 * not start, or loading stalled past `LOAD_TIMEOUT_MS`. The file goes to the
 * back of the queue and is left plain after `LOAD_TRIES`. A grammar that fails
 * to load does not come here: the worker replies `lines: null` and the file
 * stays plain without a retry.
 */
function loadFailed(w: Worker) {
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
      loadFailed(w);

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
  // Dying inside shiki (e.g. out of memory on a pathological file) would recur
  // for that file, so it counts as a timeout; dying earlier is a load failure.
  w.addEventListener('error', () => {
    if (worker !== w) {
      return;
    }
    stopWatchdog();
    if (running?.tokenising) {
      timedOut(w);
    } else {
      loadFailed(w);
    }
  });

  return w;
}

/**
 * A worker cannot be interrupted mid-file, so it is discarded. The file, and
 * any queued copy of it (e.g. from a theme switch), stays plain.
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
  watchdog = setTimeout(() => loadFailed(w), LOAD_TIMEOUT_MS);
  w.postMessage(job.request);
}

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
      // Already posted: let it finish and ignore the result.
      job.cancelled = true;
      job.done = () => undefined;
    },
  };
}

function plainLines(code: string): TokenLine[] {
  return code.split('\n').map((line) => (line ? [{ content: line }] : []));
}

/**
 * Returns plain lines until the colours arrive, so a card never renders empty;
 * plain and coloured lines hold the same text, so nothing moves. `onScreen`
 * puts the file ahead of off-screen cards in the queue.
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
          // Renders every span in the file; as a transition it yields to
          // scrolling and typing.
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

  // Mid-edit, stale tokens would show the old text under the caret; plain lines
  // are only wrong in colour for a few frames.
  return lines && forCode === code ? lines : plain;
}
