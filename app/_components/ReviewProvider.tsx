"use client";

import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { PRESETS } from "@/agent/lib/presets";
import { openPullRequest as fetchPullRequest } from "@/app/actions";
import { withPatchHeader } from "@/lib/diff";
import { fromPaste, fromPreset, fromPullRequest, type OpenReview } from "@/lib/open-review";
import { type PullRequestContext, type ReviewState, useReview } from "@/lib/useReview";

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
 */
interface ReviewControls {
  /** The example whose chip stays lit, by label. */
  activePreset: string | null;
  /** A pull request is being fetched: the Judge button waits. */
  fetching: boolean;
  openPreset: (label: string) => void;
  judgePasted: (text: string) => void;
  openPullRequest: (url: string) => void;
  startPasting: () => void;
  /** The dialog hands focus back here when it closes. */
  pasteButtonRef: RefObject<HTMLButtonElement | null>;
}

interface ReviewView {
  review: OpenReview;
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
  if (!value) throw new Error(`${hook} must be used inside <ReviewProvider>`);
  return value;
}

export function useReviewControls(): ReviewControls {
  return required(useContext(ControlsContext), "useReviewControls");
}

export function useReviewView(): ReviewView {
  return required(useContext(ViewContext), "useReviewView");
}

export function ReviewProvider({ children }: { children: ReactNode }) {
  // Opens on the first example, so the page is already a review before anyone
  // touches it.
  const [review, setReview] = useState<OpenReview>(() => fromPreset(PRESETS[0], `${PRESETS[0].label}#0`));
  const [pasting, setPasting] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [fetching, startFetching] = useTransition();
  /** Where focus goes when the paste dialog closes. */
  const pasteButtonRef = useRef<HTMLButtonElement>(null);
  // A counter, not state: two reviews opened before the next render would both
  // read the same value and share an id, and an id is what tells the hook a
  // different review is on screen.
  const nonceRef = useRef(0);
  const nextId = useCallback((kind: string) => `${kind}#${(nonceRef.current += 1)}`, []);

  // What goes on the wire: the files as shown, with every patch back under the
  // headers it was split from, so the agent's parser and its after-image read a
  // section git could have written. An emptied file stays empty — its headers
  // alone are not a question, and the card already says "Nothing to judge".
  const sent = useMemo(
    () =>
      review.files.map((file) => {
        const header = review.headers[file.path];
        if (!file.patch || !header || !file.content.trim()) return file;
        return { ...file, content: withPatchHeader(header, file.content) };
      }),
    [review.files, review.headers],
  );

  // The prompt wants the author's own words, not the node they were rendered
  // into, and a fresh object every render would be a new pull request to the
  // turn that reads it.
  const prompt = useMemo<PullRequestContext | undefined>(
    () => (review.pr ? { title: review.pr.title, body: review.pr.bodyText, url: review.pr.url } : undefined),
    [review.pr],
  );

  const judge = useReview(review.id, sent, prompt);

  const lineCount = useMemo(
    () => review.files.reduce((total, file) => total + file.content.split("\n").length, 0),
    [review.files],
  );

  const openPreset = useCallback(
    (label: string) => {
      const preset = PRESETS.find((p) => p.label === label);
      if (!preset) return;
      setReview(fromPreset(preset, nextId(label)));
      setPasting(false);
      setPrError(null);
    },
    [nextId],
  );

  const judgePasted = useCallback(
    (text: string) => {
      const next = fromPaste(text, nextId("paste"));
      if (!next) return;
      setReview(next);
      setPasting(false);
      setPrError(null);
    },
    [nextId],
  );

  /**
   * A pull request is fetched by the page's own server action: GitHub sends no
   * CORS headers for a diff, and the description comes back already rendered,
   * which is what keeps a markdown pipeline out of this bundle. The transition
   * is the "Fetching…" state — the button waits on the same update that opens
   * the review, so there is no frame where neither is true.
   */
  const openPullRequest = useCallback(
    (url: string) => {
      setPrError(null);
      startFetching(async () => {
        try {
          const answer = await fetchPullRequest(url);
          if (!answer.ok) {
            setPrError(answer.error);
            return;
          }
          const next = fromPullRequest(answer.pr, nextId("pr"));
          if (!next) {
            setPrError("That pull request has no code files to judge.");
            return;
          }
          setReview(next);
          setPasting(false);
        } catch (err) {
          setPrError(err instanceof Error ? err.message : "Could not fetch that pull request.");
        }
      });
    },
    [nextId],
  );

  const startPasting = useCallback(() => setPasting(true), []);
  const stopPasting = useCallback(() => setPasting(false), []);

  const edit = useCallback((path: string, content: string) => {
    setReview((current) => ({
      ...current,
      files: current.files.map((file) => (file.path === path ? { ...file, content } : file)),
    }));
  }, []);

  const controls = useMemo<ReviewControls>(
    () => ({
      activePreset: review.preset,
      fetching,
      openPreset,
      judgePasted,
      openPullRequest,
      startPasting,
      pasteButtonRef,
    }),
    [review.preset, fetching, openPreset, judgePasted, openPullRequest, startPasting],
  );

  const view = useMemo<ReviewView>(
    () => ({ review, judge, lineCount, prError, pasting, stopPasting, edit }),
    [review, judge, lineCount, prError, pasting, stopPasting, edit],
  );

  return (
    <ControlsContext.Provider value={controls}>
      <ViewContext.Provider value={view}>{children}</ViewContext.Provider>
    </ControlsContext.Provider>
  );
}
