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

import { PRESETS } from '@/agent/lib/presets';
import {
  openPullRequest as fetchPullRequest,
  type PullRequestAnswer,
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

/**
 * The server action, with the one way it can reject folded into the answer it
 * otherwise returns. A server action that throws reaches the browser as a
 * digest with the reason stripped out, so there is nothing to tell apart: what
 * the caller wants either way is a payload or a sentence.
 */
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

/** The review the page opens with, when the URL already named one. */
function opening(payload?: PullRequestPayload | null): {
  review: OpenReview;
  error: string | null;
  /** Where what opened is kept, in GitHub's own spelling — null if nothing did. */
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

/** What the page starts with, and what it still has to do about the URL. */
interface Arrival extends ReturnType<typeof opening> {
  /** What the address field starts with. */
  address: PullRequestAddress;
  /** The route rendered this page for another address than the one it is at. */
  restored: boolean;
  /** The pull request the address bar names and the route did not bring. */
  pending: string | null;
}

/**
 * The page as the route rendered it — unless the address bar is somewhere
 * else, in which case the address bar wins.
 *
 * Both routes render this provider, and the entries it writes itself carry
 * whichever of the two was rendering when it wrote them: Next's patched
 * `pushState` copies its route tree into every entry, and there is no tree for
 * an address the router never navigated to. Back and Forward between this
 * page's own entries never look at that tree. Back into one of them from
 * another route (`/faq`) is Next's to handle, and Next restores the tree it
 * finds: the landing route under a pull request's address, or a pull request's
 * route under `/`. The page it renders then was made for another URL, and what
 * it opens with is what the URL names — the landing view for `/`, and for a
 * pull request the same fetch Back would have made on this page.
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
 * Put the review's own address in the address bar, without navigating to it.
 * The route for a pull request renders this very page, and the page is already
 * showing it — so this is the history entry that makes Back mean something and
 * the URL something to copy, and nothing more. Next's router syncs itself with
 * the native call.
 *
 * `replace` is for the one that is not a move: an open that Back or Forward
 * started is already at its entry, and the only thing left to correct is how
 * the owner and the repository are spelled there.
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
  /** What the address field starts with, when the URL named a request. */
  initialAddress?: PullRequestAddress;
  /** Why the route could not open the request the URL named. */
  initialError?: string | null;
  /** A pull request the server already fetched, open before the first paint. */
  initialPullRequest?: PullRequestPayload | null;
}) {
  // Nothing is open until something is opened: the first visit is the door,
  // not a review. A permalink is the exception — it arrives already fetched.
  const pathname = usePathname();
  const [opened] = useState(() =>
    arrive(pathname, initialAddress, initialPullRequest, initialError),
  );
  const [review, setReview] = useState<OpenReview>(opened.review);
  const [pasting, setPasting] = useState(false);
  const [prError, setPrError] = useState<string | null>(opened.error);
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
  // Which open the page is waiting for. Everything that changes what is on
  // screen bumps it, and a fetch that comes back under an old number is
  // dropped: a pull request resolving after the reader has gone home, or gone
  // back twice, must not open itself over where they actually are.
  const generationRef = useRef(0);
  /**
   * The path the page is showing, which is not always the one it is at: a
   * `popstate` moves the address bar without re-rendering the route, and this
   * is what tells the two apart. It is written wherever the view changes —
   * including by a fetch that failed, so that the entry it failed at is not
   * fetched again on every pass over it.
   */
  const shownPathRef = useRef(opened.path ?? '/');

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
  const show = useCallback(
    (next: OpenReview, path: string, replace = false) => {
      generationRef.current += 1;
      switchView(() => {
        setReview(next);
        setPasting(false);
        setPrError(null);
        setFetching(false);
      });
      shownPathRef.current = path;
      showPath(path, replace);
      document.title = next.pr ? `${next.pr.title} · ${SITE.name}` : SITE.name;
    },
    [],
  );

  /**
   * A fetch that opened nothing, put on screen.
   *
   * Asked for by hand it is only a notice: whatever is open stays open, above
   * the reason the next one did not. Asked for by Back or Forward it is also a
   * reconciliation — the address bar has already moved, and a review the URL
   * no longer names cannot stay on screen — so the landing view comes back
   * with the reason on it, the tab is renamed, and that entry is marked as
   * shown so that passing over it again is not another fetch.
   */
  const showError = useCallback((message: string, entry: string | null) => {
    if (!entry) {
      setPrError(message);
      setFetching(false);
      return;
    }
    switchView(() => {
      setReview(NO_REVIEW);
      setPasting(false);
      setPrError(message);
      setFetching(false);
    });
    shownPathRef.current = entry;
    document.title = SITE.name;
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
   * What the fetch came back with, put on screen: the review it opened, or the
   * reason it opened none.
   *
   * The URL the page ends on is GitHub's own, not the one that was typed: it
   * is the canonical spelling of the owner and the repository. `entry` is the
   * history entry this open came from, when Back or Forward started it and not
   * the button — the address bar is already there, so that spelling replaces
   * it rather than pushing another entry on top of it.
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
   * A pull request is fetched by the page's own server action: GitHub sends no
   * CORS headers for a diff, and the description comes back already rendered,
   * which is what keeps a markdown pipeline out of this bundle. The fetch is
   * not wrapped in a transition, because the update that opens the review has
   * to be flushed inside the browser's own view transition and a transition's
   * update cannot be; `fetching` is the "Fetching…" state instead.
   *
   * A number taken at the start and checked at the end is what makes a late
   * answer harmless. GitHub is slower than a second press of Back, and a
   * review that opened itself over the page the reader had already returned to
   * — rewriting the history they were walking through — is the bug that guards
   * against.
   */
  const open = useCallback(
    (url: string, entry: string | null) => {
      generationRef.current += 1;
      const generation = generationRef.current;
      setPrError(null);
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
  useEffect(() => {
    function onPopState() {
      const path = window.location.pathname;
      if (path === shownPathRef.current) {
        // The page already shows this address — but a fetch for the entry the
        // reader just left may still be on its way, and it must not open
        // itself over this one when it lands.
        generationRef.current += 1;
        setFetching(false);
        return;
      }
      if (path === '/') {
        show(NO_REVIEW, '/');
        return;
      }
      const parts = splitPullRequest(path.slice(1));
      if (parts) {
        open(pullRequestUrl(parts.repo, parts.number), path);
      }
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [open, show]);

  /**
   * The address bar, corrected once to the spelling the page is showing.
   *
   * GitHub answers to any capitalisation of an owner and a repository, and to
   * a repository's old name, so a permalink can arrive as
   * `/Facebook/React/pull/2` while the review that came back is kept at
   * `/react/react/pull/2`. `replaceState` rather than a push: the two are one
   * page, and Back should leave the site rather than swap the spelling. With
   * nothing open there is nothing to correct to — the URL that failed is the
   * one this entry shows, error notice and all, and saying so here is what
   * keeps Back to it from fetching again.
   *
   * The correction waits for the end of this commit's effects. Next patches
   * `replaceState` to keep its own state (the router tree, and the flag that
   * says the entry is its to restore) in every entry written from outside it,
   * but it installs that patch in an effect of the router, and a parent's
   * effects run after its children's. Written from here directly, the entry's
   * state is `null` — which Next's `popstate` handler ignores, so Back into it
   * from `/faq`, where this page is not mounted to answer, changed the address
   * bar and nothing else.
   *
   * A page restored under another address than its route's (see `arrive`)
   * opens what the address names instead, and takes the site's name back from
   * the route it was rendered for.
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
      // A fetch this page started must not settle over whatever replaced it.
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

  /**
   * What the two boxes say: the review that is on screen, not the one the page
   * was opened with. Back and Forward change which pull request is open
   * without the route re-rendering, and a field still naming the one before it
   * is the same lie as a tab still named after it. With nothing open the
   * address the page arrived at is what is left — the field is not emptied
   * under someone who is typing in it.
   */
  const openedOnce = useRef(false);
  const address = useMemo<PullRequestAddress>(() => {
    if (review.pr) {
      openedOnce.current = true;
      return splitPullRequest(review.pr.url) ?? opened.address;
    }
    // A closed review names nothing; only a page that has shown nothing yet
    // keeps the address it arrived with, so a failed permalink stays in the
    // boxes for correcting.
    return openedOnce.current ? NO_ADDRESS : opened.address;
  }, [review.pr, opened.address]);

  const controls = useMemo<ReviewControls>(
    () => ({
      activePreset: review.preset,
      address,
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
      address,
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
