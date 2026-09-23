'use client';

import { usePathname } from 'next/navigation';
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

import { PRESETS } from '@/examples/presets';
import { switchView } from '@/src/landing/view-transition';
import {
  openPullRequest as fetchPullRequest,
  type PullRequestAnswer,
  type PullRequestPayload,
} from '@/src/pull-request/actions';
import {
  NO_ADDRESS,
  type PullRequestAddress,
  pullRequestPath,
  pullRequestUrl,
  splitPullRequest,
} from '@/src/pull-request/address';
import { REVIEW_PATH, SITE } from '@/src/site/site';

import { withPatchHeader } from './diff';
import {
  fromPaste,
  fromPreset,
  fromPullRequest,
  type OpenReview,
} from './open-review';
import {
  type PullRequestContext,
  type ReviewState,
  useReview,
} from './useReview';

/**
 * All changing page state lives here so the static parts can be server-rendered
 * and passed in as children; interactive islands read a context instead of
 * props threaded through static markup.
 *
 * Two contexts: controls change when a review opens, the view on every
 * streamed token, and a chip should not re-render for the latter.
 */
interface ReviewControls {
  /** By label. */
  activePreset: string | null;
  address: PullRequestAddress;
  fetching: boolean;
  goHome: () => void;
  openPreset: (label: string) => void;
  judgePasted: (text: string) => void;
  openPullRequest: (url: string) => void;
  startPasting: () => void;
  /** The paste dialog returns focus here on close. */
  pasteButtonRef: RefObject<HTMLButtonElement | null>;
  retryPullRequest: () => void;
  dismissPrError: () => void;
  /** False when there was nothing to retry. */
  retryJudging: () => boolean;
  /** Files judged in part or not at all; false when none could be asked. */
  rejudge: (paths: readonly string[]) => boolean;
}

interface ReviewView {
  review: OpenReview;
  /** False on the landing view. */
  open: boolean;
  /**
   * The page has given the review its layout: a review is open, or one was
   * asked for and the answer — the pull request, or a refusal — has not sent
   * the reader back to the start. The room is held from the press, so nothing
   * the answer brings moves anything (the page's whole cumulative layout shift
   * used to be this one change, landing ~700ms after the click and so outside
   * the 500ms a browser forgives).
   */
  committed: boolean;
  reviewState: ReviewState;
  lineCount: number;
  prError: string | null;
  /** `prError` stays shown while this is true. */
  retryingPr: boolean;
  pasting: boolean;
  stopPasting: () => void;
  edit: (path: string, content: string) => void;
}

const ControlsContext = createContext<ReviewControls | null>(null);
const ViewContext = createContext<ReviewView | null>(null);

function required<T>(value: T | null, hook: string): T {
  if (!value) {
    throw new Error(`${hook} must be used inside <ReviewProvider>`);
  }

  return value;
}

export function useReviewControls(): ReviewControls {
  return required(useContext(ControlsContext), 'useReviewControls');
}

export function useReviewView(): ReviewView {
  return required(useContext(ViewContext), 'useReviewView');
}

// An empty review rather than null: everything downstream already handles
// "no files".
const NO_REVIEW: OpenReview = {
  files: [],
  headers: {},
  id: 'landing',
  pr: null,
  preset: null,
  skipped: [],
  skippedCount: 0,
  total: { code: 0, prose: 0 },
  truncated: {},
};

const NOTHING_TO_JUDGE = 'That pull request has no code files to judge.';

// A throwing server action reaches the browser as a digest with the reason
// stripped, so a rejection is folded into an ordinary error answer.
async function answered(url: string): Promise<PullRequestAnswer> {
  try {
    return await fetchPullRequest(url);
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? err.message
          : 'Could not fetch that pull request.',
      ok: false,
    };
  }
}

function opening(payload?: PullRequestPayload | null): {
  review: OpenReview;
  error: string | null;
  /** In GitHub's canonical spelling. */
  path: string | null;
} {
  if (!payload) {
    return { error: null, path: null, review: NO_REVIEW };
  }
  const review = fromPullRequest(payload, 'pr#0');

  return review
    ? { error: null, path: pullRequestPath(payload.url) ?? '/', review }
    : { error: NOTHING_TO_JUDGE, path: null, review: NO_REVIEW };
}

interface Arrival extends ReturnType<typeof opening> {
  address: PullRequestAddress;
  /** The route rendered this page for a different address than the current one. */
  restored: boolean;
  /** A pull request the address bar names that the route did not bring. */
  pending: string | null;
}

/**
 * The address bar wins over the route. Next's patched `pushState` copies the
 * current route tree into every entry this page writes, so Back into one from
 * another route (e.g. `/faq`) can restore the landing route under a pull
 * request's address, or the reverse. The page then opens what the URL names.
 */
function arrive(
  pathname: string,
  address: PullRequestAddress,
  payload: PullRequestPayload | null,
  error: string | null,
): Arrival {
  const opened = opening(payload);
  const route = address.repo
    ? pullRequestPath(pullRequestUrl(address.repo, address.number))
    : '/';
  const here = pathname === '/' ? '/' : pullRequestPath(pathname.slice(1));

  if (here === null || here === route || here === opened.path) {
    return {
      ...opened,
      address,
      error: error ?? opened.error,
      pending: null,
      restored: false,
    };
  }
  const pending = here === '/' ? null : pathname;

  return {
    address: (pending && splitPullRequest(pending.slice(1))) || NO_ADDRESS,
    error: null,
    path: null,
    pending,
    restored: true,
    review: NO_REVIEW,
  };
}

/**
 * Updates the address bar without navigating: the page already shows the
 * review. Next's router syncs itself with the native call. `replace` is for
 * opens started by Back/Forward, which only correct the spelling.
 */
function showPath(path: string, replace = false): void {
  if (window.location.pathname === path) {
    return;
  }
  if (replace) {
    window.history.replaceState(null, '', path);

    return;
  }
  window.history.pushState(null, '', path);
}

export function ReviewProvider({
  children,
  initialAddress = NO_ADDRESS,
  initialError = null,
  initialPullRequest = null,
}: {
  children: ReactNode;
  initialAddress?: PullRequestAddress;
  initialError?: string | null;
  /** Fetched by the server, so a permalink is open before first paint. */
  initialPullRequest?: PullRequestPayload | null;
}) {
  const pathname = usePathname();
  const [opened] = useState(() =>
    arrive(pathname, initialAddress, initialPullRequest, initialError),
  );
  const [review, setReview] = useState<OpenReview>(opened.review);
  const [pasting, setPasting] = useState(false);
  const [prError, setPrError] = useState<string | null>(opened.error);
  const [fetching, setFetching] = useState(false);
  const [retryingPr, setRetryingPr] = useState(false);
  /**
   * The reader asked this page for a review. True from the press until the
   * page goes back to the start, so a refusal is answered in the review's
   * layout rather than by putting the landing view back under the reader.
   */
  const [asked, setAsked] = useState(false);
  /** What Retry asks for again; seeded by a permalink that failed on the server. */
  const lastAskedRef = useRef<{ url: string; entry: string | null } | null>(
    opened.error && initialAddress.repo
      ? {
          entry: null,
          url: pullRequestUrl(initialAddress.repo, initialAddress.number),
        }
      : null,
  );
  const pasteButtonRef = useRef<HTMLButtonElement>(null);
  // A ref, not state: two opens before the next render would share an id, and
  // the id is how useReview detects a different review.
  const nonceRef = useRef(0);
  const nextId = useCallback((kind: string) => {
    nonceRef.current += 1;

    return `${kind}#${nonceRef.current}`;
  }, []);
  // Bumped by everything that changes the view; a fetch that settles under an
  // old value is dropped, so a slow pull request cannot open over wherever the
  // reader has since gone.
  const generationRef = useRef(0);
  /**
   * Can differ from the address bar after `popstate`, which does not re-render
   * the route. Also set by a failed fetch, so passing over that entry again
   * does not refetch.
   */
  const shownPathRef = useRef(opened.path ?? '/');

  // Patches go back under their headers so the agent parses what git would
  // write. An emptied file stays empty: headers alone are not a question.
  const sent = useMemo(
    () =>
      review.files.map((file) => {
        const header = review.headers[file.path];

        if (!file.patch || !header || !file.content.trim()) {
          return file;
        }

        return { ...file, content: withPatchHeader(header, file.content) };
      }),
    [review.files, review.headers],
  );

  // Memoised: a fresh object each render would look like a new pull request.
  const prompt = useMemo<PullRequestContext | undefined>(
    () =>
      review.pr
        ? {
            body: review.pr.bodyText,
            title: review.pr.title,
            url: review.pr.url,
          }
        : undefined,
    [review.pr],
  );

  const { state: reviewState, actions: judging } = useReview(
    review.id,
    sent,
    prompt,
  );

  const lineCount = useMemo(
    () =>
      review.files.reduce(
        (total, file) => total + file.content.split('\n').length,
        0,
      ),
    [review.files],
  );

  /**
   * State updates run inside `switchView` so the browser can animate the
   * change. The title is set by hand because this is not a navigation, so the
   * route's metadata never re-runs; the template repeats the layout's.
   */
  const show = useCallback(
    (next: OpenReview, path: string, replace = false) => {
      generationRef.current += 1;
      switchView(() => {
        setReview(next);
        setAsked(next.id !== NO_REVIEW.id);
        setPasting(false);
        setPrError(null);
        setFetching(false);
        setRetryingPr(false);
      });
      shownPathRef.current = path;
      showPath(path, replace);
      document.title = next.pr ? `${next.pr.title} · ${SITE.name}` : SITE.name;
    },
    [],
  );

  /**
   * Without `entry` it is only a notice; the open review stays. From
   * Back/Forward the address bar has already moved, so the review the URL no
   * longer names is closed and the entry marked shown to avoid a refetch.
   */
  const showError = useCallback((message: string, entry: string | null) => {
    if (!entry) {
      setPrError(message);
      setFetching(false);
      setRetryingPr(false);

      return;
    }
    switchView(() => {
      setReview(NO_REVIEW);
      setPasting(false);
      setPrError(message);
      setFetching(false);
      setRetryingPr(false);
    });
    shownPathRef.current = entry;
    document.title = SITE.name;
  }, []);

  const goHome = useCallback(() => {
    show(NO_REVIEW, '/');
  }, [show]);

  const openPreset = useCallback(
    (label: string) => {
      const preset = PRESETS.find((p) => p.label === label);

      if (!preset) {
        return;
      }
      show(fromPreset(preset, nextId(label)), REVIEW_PATH);
    },
    [nextId, show],
  );

  const judgePasted = useCallback(
    (text: string) => {
      const next = fromPaste(text, nextId('paste'));

      if (!next) {
        return;
      }
      show(next, REVIEW_PATH);
    },
    [nextId, show],
  );

  /**
   * The URL becomes GitHub's canonical spelling. `entry` is set when
   * Back/Forward started the open; the address bar is already there, so the
   * spelling replaces it instead of pushing an entry.
   */
  const settle = useCallback(
    (answer: PullRequestAnswer, entry: string | null) => {
      if (!answer.ok) {
        showError(answer.error, entry);

        return;
      }
      const next = fromPullRequest(answer.pr, nextId('pr'));

      if (!next) {
        showError(NOTHING_TO_JUDGE, entry);

        return;
      }
      show(next, pullRequestPath(answer.pr.url) ?? '/', entry !== null);
    },
    [nextId, show, showError],
  );

  /**
   * Via a server action: GitHub sends no CORS headers for a diff, and the
   * description arrives pre-rendered, keeping markdown out of the bundle. Not
   * a React transition: the opening update must flush inside the browser's
   * view transition, which a transition's update cannot. The generation check
   * stops a late answer rewriting history the reader has since walked back.
   */
  const open = useCallback(
    (url: string, entry: string | null, retrying = false) => {
      generationRef.current += 1;
      const generation = generationRef.current;

      lastAskedRef.current = { entry, url };
      // Not inside `switchView`: this is where the page takes the review's
      // shape, and it has to be painted while the browser still credits the
      // press for it. A transition holds the new layout back behind its
      // snapshots, and the change lands as a shift nobody asked for.
      setAsked(true);
      // A retry keeps the error shown so it does not blink away and back.
      if (!retrying) {
        setPrError(null);
      }
      setRetryingPr(retrying);
      setFetching(true);
      const run = async () => {
        const answer = await answered(url);

        if (generationRef.current === generation) {
          settle(answer, entry);
        }
      };

      run().catch(() => {
        /* Every way this fails is already on screen. */
      });
    },
    [settle],
  );

  const openPullRequest = useCallback(
    (url: string) => {
      open(url, null);
    },
    [open],
  );

  const retryPullRequest = useCallback(() => {
    const last = lastAskedRef.current;

    if (last) {
      open(last.url, last.entry, true);
    }
  }, [open]);

  /**
   * The way out of a refusal, whether the duck is saying it or the review's
   * layout is: it puts the landing view back, which is a view change and one
   * the press pays for. The generation is bumped as `goHome` bumps it, because
   * a retry may still be in flight and its answer must not arrive on top of a
   * reader who has left — as a review, or as the refusal just dismissed. The
   * review itself stays: a refused second pull request is dismissed from an
   * open review without closing it.
   */
  const dismissPrError = useCallback(() => {
    generationRef.current += 1;
    switchView(() => {
      setPrError(null);
      setAsked(false);
      setFetching(false);
      setRetryingPr(false);
    });
  }, []);

  /**
   * Next does not re-render the route for entries this page pushed, so the
   * page reconciles itself with the URL. A pull request reopens from the
   * server's minute-long cache. Neither case writes a history entry.
   */
  useEffect(() => {
    function onPopState() {
      const path = window.location.pathname;

      if (path === shownPathRef.current) {
        // A fetch for the entry just left may still land; invalidate it.
        generationRef.current += 1;
        setFetching(false);
        setRetryingPr(false);

        return;
      }
      if (path === '/') {
        show(NO_REVIEW, '/');

        return;
      }
      const parts = splitPullRequest(path.slice(1));

      if (parts) {
        open(pullRequestUrl(parts.repo, parts.number), path);

        return;
      }
      // A pasted review is not kept anywhere, so its address, and any other
      // this page pushed, falls back to the landing view rather than leaving
      // the page under an address it cannot fill.
      show(NO_REVIEW, '/', true);
    }
    window.addEventListener('popstate', onPopState);

    return () => window.removeEventListener('popstate', onPopState);
  }, [open, show]);

  /**
   * Corrects a permalink once to GitHub's spelling (GitHub accepts any case and
   * old repo names). `replaceState`, so Back leaves the site rather than swap
   * spellings. With nothing open, the failed URL is recorded as shown so Back
   * to it does not refetch.
   *
   * Deferred with setTimeout: Next patches `replaceState` to store its router
   * state in an effect of the router, and a parent's effects run after its
   * children's. Called directly, the entry's state is null, which Next's
   * `popstate` ignores, so Back into it from `/faq` changed only the address.
   *
   * A page restored under another address (see `arrive`) opens what the
   * address names instead, and drops the title the other route set.
   */
  useEffect(() => {
    let correction = 0;

    if (opened.restored) {
      document.title = SITE.name;
    }
    const parts = opened.pending && splitPullRequest(opened.pending.slice(1));

    if (opened.pending && parts) {
      open(pullRequestUrl(parts.repo, parts.number), opened.pending);
    } else if (opened.path) {
      const path = opened.path;

      correction = window.setTimeout(() => showPath(path, true), 0);
    } else {
      shownPathRef.current = window.location.pathname;
    }

    return () => {
      window.clearTimeout(correction);
      generationRef.current += 1;
    };
  }, [opened, open]);

  const startPasting = useCallback(() => setPasting(true), []);
  const stopPasting = useCallback(() => setPasting(false), []);

  const edit = useCallback((path: string, content: string) => {
    setReview((current) => ({
      ...current,
      files: current.files.map((file) =>
        file.path === path ? { ...file, content } : file,
      ),
    }));
  }, []);

  // Follows the review on screen, since Back/Forward change it without the
  // route re-rendering.
  const openedOnce = useRef(false);
  const address = useMemo<PullRequestAddress>(() => {
    if (review.pr) {
      openedOnce.current = true;

      return splitPullRequest(review.pr.url) ?? opened.address;
    }

    // Until a review has been shown, keep the arrival address so a failed
    // permalink stays in the boxes for correcting.
    return openedOnce.current ? NO_ADDRESS : opened.address;
  }, [review.pr, opened.address]);

  const controls = useMemo<ReviewControls>(
    () => ({
      activePreset: review.preset,
      address,
      dismissPrError,
      fetching,
      goHome,
      judgePasted,
      openPreset,
      openPullRequest,
      pasteButtonRef,
      rejudge: judging.rejudge,
      retryJudging: judging.retry,
      retryPullRequest,
      startPasting,
    }),
    [
      review.preset,
      address,
      fetching,
      goHome,
      openPreset,
      judgePasted,
      openPullRequest,
      startPasting,
      judging,
      dismissPrError,
      retryPullRequest,
    ],
  );

  const view = useMemo<ReviewView>(() => {
    // Not `open`: that name is the callback that fetches a pull request.
    const showing = review.id !== NO_REVIEW.id;

    return {
      committed: showing || asked,
      edit,
      lineCount,
      open: showing,
      pasting,
      prError,
      retryingPr,
      review,
      reviewState,
      stopPasting,
    };
  }, [
    review,
    reviewState,
    lineCount,
    asked,
    prError,
    retryingPr,
    pasting,
    stopPasting,
    edit,
  ]);

  return (
    <ControlsContext.Provider value={controls}>
      <ViewContext.Provider value={view}>{children}</ViewContext.Provider>
    </ControlsContext.Provider>
  );
}
