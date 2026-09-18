'use client';

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

import { PRESETS } from '@/agent/lib/presets';
import {
  openPullRequest as fetchPullRequest,
  type PullRequestPayload,
} from '@/app/actions';
import {
  NO_ADDRESS,
  type PullRequestAddress,
  pullRequestPath,
  pullRequestUrl,
  splitPullRequest,
} from '@/lib/address';
import { withPatchHeader } from '@/lib/diff';
import {
  fromPaste,
  fromPreset,
  fromPullRequest,
  type OpenReview,
} from '@/lib/open-review';
import { SITE } from '@/lib/site';
import {
  type PullRequestContext,
  type ReviewState,
  useReview,
} from '@/lib/useReview';
import { switchView } from '@/lib/view-transition';

/**
 * The review the page is showing, and the four ways to open another one.
 *
 * Everything on this page that changes lives here, so that everything that
 * does not — the frame around it, the examples line, the footer, the questions
 * at the bottom — can be rendered on the server and handed in as children.
 * The islands that do need a handler (a chip, the address field, the paste
 * button) read it from one of the two contexts below rather than from props
 * threaded through markup that has no business being interactive.
 *
 * Two contexts, not one: the controls change when a different review is opened
 * and the view changes on every token of a streaming answer, and a chip has no
 * reason to re-render for the second.
 *
 * Whether a review is open is also what view the page is in. With none open it
 * is the landing view — the duck at its full size, the field, the examples and
 * the questions. Opening one is the code view, and closing it is the duck.
 */
interface ReviewControls {
  /** The example whose chip stays lit, by label. */
  activePreset: string | null;
  /** What the address field starts with: empty, or the URL's own request. */
  address: PullRequestAddress;
  /** A pull request is being fetched: the Judge button waits. */
  fetching: boolean;
  /** Close the review and go back to the landing view — what the duck does. */
  goHome: () => void;
  openPreset: (label: string) => void;
  judgePasted: (text: string) => void;
  openPullRequest: (url: string) => void;
  startPasting: () => void;
  /** The dialog hands focus back here when it closes. */
  pasteButtonRef: RefObject<HTMLButtonElement | null>;
}

interface ReviewView {
  review: OpenReview;
  /** A review is on screen, so the page is the code view rather than the door. */
  open: boolean;
  /** What the agent has answered so far, and what it is doing now. */
  judge: ReviewState;
  lineCount: number;
  /** Why the last pull request never opened. */
  prError: string | null;
  pasting: boolean;
  stopPasting: () => void;
  /** An edit replaces that file's content and nothing else in the review. */
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

/**
 * The review that is not one: what the page holds on the landing view, before
 * anything has been opened. It is a whole `OpenReview` with nothing in it
 * rather than a null, because everything downstream of it reads a review and
 * "no files" is a state each of those parts already understands.
 */
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

/** What a pull request with nothing worth judging in it is called on screen. */
const NOTHING_TO_JUDGE = 'That pull request has no code files to judge.';

/** The review the page opens with, when the URL already named one. */
function opening(payload?: PullRequestPayload | null): {
  review: OpenReview;
  error: string | null;
} {
  if (!payload) {
    return { error: null, review: NO_REVIEW };
  }
  const review = fromPullRequest(payload, 'pr#0');
  return review
    ? { error: null, review }
    : { error: NOTHING_TO_JUDGE, review: NO_REVIEW };
}

/**
 * Put the review's own address in the address bar, without navigating to it.
 * The route for a pull request renders this very page, and the page is already
 * showing it — so this is the history entry that makes Back mean something and
 * the URL something to copy, and nothing more. Next's router syncs itself with
 * the native call.
 */
function showPath(path: string): void {
  if (window.location.pathname !== path) {
    window.history.pushState(null, '', path);
  }
}

export function ReviewProvider({
  children,
  initialAddress = NO_ADDRESS,
  initialError = null,
  initialPullRequest = null,
}: {
  children: ReactNode;
  /** What the address field starts with, when the URL named a request. */
  initialAddress?: PullRequestAddress;
  /** Why the route could not open the request the URL named. */
  initialError?: string | null;
  /** A pull request the server already fetched, open before the first paint. */
  initialPullRequest?: PullRequestPayload | null;
}) {
  // Nothing is open until something is opened: the first visit is the door,
  // not a review. A permalink is the exception — it arrives already fetched.
  const [opened] = useState(() => opening(initialPullRequest));
  const [review, setReview] = useState<OpenReview>(opened.review);
  const [pasting, setPasting] = useState(false);
  const [prError, setPrError] = useState<string | null>(
    initialError ?? opened.error,
  );
  const [fetching, setFetching] = useState(false);
  /** Where focus goes when the paste dialog closes. */
  const pasteButtonRef = useRef<HTMLButtonElement>(null);
  // A counter, not state: two reviews opened before the next render would both
  // read the same value and share an id, and an id is what tells the hook a
  // different review is on screen.
  const nonceRef = useRef(0);
  const nextId = useCallback((kind: string) => {
    nonceRef.current += 1;
    return `${kind}#${nonceRef.current}`;
  }, []);

  // What goes on the wire: the files as shown, with every patch back under the
  // headers it was split from, so the agent's parser and its after-image read a
  // section git could have written. An emptied file stays empty — its headers
  // alone are not a question, and the card already says "Nothing to judge".
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

  // The prompt wants the author's own words, not the node they were rendered
  // into, and a fresh object every render would be a new pull request to the
  // turn that reads it.
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

  const judge = useReview(review.id, sent, prompt);

  const lineCount = useMemo(
    () =>
      review.files.reduce(
        (total, file) => total + file.content.split('\n').length,
        0,
      ),
    [review.files],
  );

  /**
   * The one way a review opens, whichever door it came through: the page
   * changes shape and the address bar follows it. The shape change is animated
   * — the duck shrinks from the landing's mascot into the mark beside the
   * field, and everything else crosses over — which is why the state update is
   * handed to the browser rather than made here.
   *
   * The tab's name goes with the address. Neither of these is a navigation, so
   * nothing re-runs the route's metadata — and a tab still named after the
   * pull request you just closed is the same lie as a URL still pointing at
   * it. The template is the layout's, written out because this side of the
   * boundary has no metadata to inherit it from.
   */
  const show = useCallback((next: OpenReview, path: string) => {
    switchView(() => {
      setReview(next);
      setPasting(false);
      setPrError(null);
    });
    showPath(path);
    document.title = next.pr ? `${next.pr.title} · ${SITE.name}` : SITE.name;
  }, []);

  /** The duck's click: close the review and stand at the door again. */
  const goHome = useCallback(() => {
    show(NO_REVIEW, '/');
  }, [show]);

  const openPreset = useCallback(
    (label: string) => {
      const preset = PRESETS.find((p) => p.label === label);
      if (!preset) {
        return;
      }
      show(fromPreset(preset, nextId(label)), '/');
    },
    [nextId, show],
  );

  const judgePasted = useCallback(
    (text: string) => {
      const next = fromPaste(text, nextId('paste'));
      if (!next) {
        return;
      }
      show(next, '/');
    },
    [nextId, show],
  );

  /**
   * A pull request is fetched by the page's own server action: GitHub sends no
   * CORS headers for a diff, and the description comes back already rendered,
   * which is what keeps a markdown pipeline out of this bundle. The fetch is
   * not wrapped in a transition, because the update that opens the review has
   * to be flushed inside the browser's own view transition and a transition's
   * update cannot be; `fetching` is the "Fetching…" state instead.
   *
   * The URL the page ends on is GitHub's own, not the one that was typed: it
   * is the canonical spelling of the owner and the repository.
   */
  const openPullRequest = useCallback(
    (url: string) => {
      setPrError(null);
      setFetching(true);
      const run = async () => {
        try {
          const answer = await fetchPullRequest(url);
          if (!answer.ok) {
            setPrError(answer.error);
            return;
          }
          const next = fromPullRequest(answer.pr, nextId('pr'));
          if (!next) {
            setPrError(NOTHING_TO_JUDGE);
            return;
          }
          show(next, pullRequestPath(answer.pr.url) ?? '/');
        } catch (err) {
          setPrError(
            err instanceof Error
              ? err.message
              : 'Could not fetch that pull request.',
          );
        } finally {
          setFetching(false);
        }
      };
      run().catch(() => {
        /* Every way this fails is already on screen. */
      });
    },
    [nextId, show],
  );

  /**
   * Back and forward, over the entries the page wrote itself.
   *
   * Next does not re-render for these: a `pushState` that did not navigate
   * leaves the route as it was, and the router only moves `usePathname` along
   * — so on a `popstate` the URL can say one thing while the page shows
   * another, and putting those back together is this page's own job. Going
   * back to `/` closes the review; going back to a pull request the page is
   * not showing opens it again, from the server's minute-long cache rather
   * than from GitHub. Neither writes a history entry: the address bar is
   * already where it is going.
   */
  const shownPath = review.pr ? (pullRequestPath(review.pr.url) ?? '/') : '/';
  const shownPathRef = useRef(shownPath);
  shownPathRef.current = shownPath;

  useEffect(() => {
    function onPopState() {
      const path = window.location.pathname;
      if (path === shownPathRef.current) {
        return;
      }
      if (path === '/') {
        show(NO_REVIEW, '/');
        return;
      }
      const parts = splitPullRequest(path.slice(1));
      if (parts) {
        openPullRequest(pullRequestUrl(parts.repo, parts.number));
      }
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [openPullRequest, show]);

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

  const controls = useMemo<ReviewControls>(
    () => ({
      activePreset: review.preset,
      address: initialAddress,
      fetching,
      goHome,
      judgePasted,
      openPreset,
      openPullRequest,
      pasteButtonRef,
      startPasting,
    }),
    [
      review.preset,
      initialAddress,
      fetching,
      goHome,
      openPreset,
      judgePasted,
      openPullRequest,
      startPasting,
    ],
  );

  const view = useMemo<ReviewView>(
    () => ({
      edit,
      judge,
      lineCount,
      open: review.id !== NO_REVIEW.id,
      pasting,
      prError,
      review,
      stopPasting,
    }),
    [review, judge, lineCount, prError, pasting, stopPasting, edit],
  );

  return (
    <ControlsContext.Provider value={controls}>
      <ViewContext.Provider value={view}>{children}</ViewContext.Provider>
    </ControlsContext.Provider>
  );
}
