'use client';

import { type ReactNode, useEffect, useState } from 'react';

import type { RecentPullRequest } from '@/agent/lib/github/recent';
import { splitPullRequest } from '@/src/pull-request/address';
import { useReviewControls } from '@/src/review/ReviewProvider';
import { handOn } from '@/src/ui/hand-on';

const RECENT_URL = '/api/recent-prs';

/** The endpoint's own ceiling, kept here so a longer answer is still one row. */
const MAX_CHIPS = 5;

/**
 * A shape check, not a sanitiser: the endpoint is ours, and `recent.ts` has
 * already stripped and clamped the title — the last place that can. This drops
 * a refusal's `{error}` payload, which carries no list at all, and any row
 * missing a field a press needs.
 */
function isPullRequest(row: unknown): row is RecentPullRequest {
  const { number, repo, title, url } = (row ??
    {}) as Partial<RecentPullRequest>;

  return (
    typeof number === 'number' &&
    Number.isInteger(number) &&
    number > 0 &&
    typeof repo === 'string' &&
    repo.includes('/') &&
    typeof title === 'string' &&
    title !== '' &&
    typeof url === 'string' &&
    splitPullRequest(url) !== null
  );
}

function listFrom(json: unknown): RecentPullRequest[] {
  const rows = (json as { pullRequests?: unknown } | null)?.pullRequests;

  return Array.isArray(rows)
    ? rows.filter(isPullRequest).slice(0, MAX_CHIPS)
    : [];
}

/**
 * From the browser, after the page is on screen. The route's answer is a shared
 * cache entry a cold visit has to walk GitHub to fill, so rendering it on the
 * server would hold the first paint behind that walk and make a static page
 * dynamic for a decoration. Arriving late costs nothing because the row's room
 * is reserved in `Hero` before the list exists.
 */
function useRecentPullRequests(): RecentPullRequest[] {
  const [pullRequests, setPullRequests] = useState<RecentPullRequest[]>([]);

  useEffect(() => {
    const controller = new AbortController();

    fetch(RECENT_URL, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => setPullRequests(listFrom(json)))
      .catch(() => {
        /* A refusal, a failed fetch and a quiet fortnight are one answer: no row. */
      });

    return () => controller.abort();
  }, []);

  return pullRequests;
}

/**
 * `PresetChip`'s shape — height, radius, border, type and hover — filled rather
 * than outlined, which with the number is what tells a live pull request from a
 * canned example.
 */
const CHIP =
  'inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-xs text-muted hover:border-muted hover:text-ink motion-safe:transition-colors lg:min-h-0 lg:px-2.5 lg:py-1';

/** Enough of a 120-character title to say what changed; the rest is clipped. */
const TITLE = 'truncate max-w-[9rem] lg:max-w-[13rem]';

function RecentChip({ pullRequest }: { pullRequest: RecentPullRequest }) {
  const { openPullRequest } = useReviewControls();
  const { number, repo, title, url } = pullRequest;
  /**
   * Written out, because the chip is not: one line has no room for the owner —
   * `react` and `TypeScript` are the halves a reader knows — and the title is
   * clipped to fit.
   */
  const said = `${repo} #${number}: ${title}`;

  return (
    <button
      aria-label={said}
      className={CHIP}
      // The press takes the page into the review's layout, where this whole row
      // is gone, so the focus that made it is handed to the duck that opens
      // that layout rather than dropped on `<body>`.
      onClick={(event) => {
        handOn(event.currentTarget, '[data-duck=home]');
        openPullRequest(url);
      }}
      type="button"
    >
      <span className="whitespace-nowrap font-medium">
        {repo.slice(repo.indexOf('/') + 1)} #{number}
      </span>
      {/* The tooltip sits on the clipped text, not on the button: with
          `aria-label` set, a title there is an accessible description, read
          out after the name it repeats. */}
      <span className={TITLE} title={title}>
        {title}
      </span>
    </button>
  );
}

/**
 * One line at every width, scrolled sideways rather than wrapped: a wrapped row
 * is a different height for every list, and the room is held before the list
 * exists. The scrollbar is hidden rather than allowed for, because where it is
 * not an overlay it would draw across a chip inside that fixed height. The
 * inset padding is the room the focus ring needs at either end, and the scroll
 * padding is the same room again for a chip Tab scrolls into view: scrolling
 * to a chip stops at its border box, which would put the ring under the edge.
 */
const STRIP =
  '-mx-1 flex h-full items-center gap-2 overflow-x-auto scroll-px-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

export function RecentPullRequests({ children }: { children: ReactNode }) {
  const pullRequests = useRecentPullRequests();

  // Nothing until there is something real to press: the row is decoration, and
  // its absence has to read as a page that was never going to have one.
  if (pullRequests.length === 0) {
    return null;
  }

  return (
    <div className={STRIP}>
      {children}
      {pullRequests.map((pullRequest) => (
        <RecentChip key={pullRequest.url} pullRequest={pullRequest} />
      ))}
    </div>
  );
}
