import { headers } from 'next/headers';
import { cache, createElement, type ReactNode } from 'react';

import { cached, cacheKey } from '@/agent/lib/cache';
import { fetchPullRequest } from '@/agent/lib/github';
import { PullRequestBody } from '@/app/_components/PullRequestBody';
import { callerIp, throttled } from '@/lib/throttle';

/**
 * A pull request, fetched for the page.
 *
 * The description arrives as a React node rather than as markdown: it is
 * rendered here, on the server, so `react-markdown` and its whole markdown
 * pipeline stay out of the browser's bundle. The same text comes along as
 * `bodyText`, because the review prompt carries the author's own words to Luna
 * and a rendered node is no use to a model.
 */
export interface PullRequestPayload {
  url: string;
  title: string;
  /** The description, already rendered. Null when there is none. */
  body: ReactNode;
  /** The description as the author wrote it, for the summarize turn. */
  bodyText: string;
  diff: string;
  /** Files GitHub reports on the PR, for the skip count. */
  changedFiles: number;
}

export type PullRequestAnswer =
  | { ok: true; pr: PullRequestPayload }
  | { ok: false; error: string };

/**
 * A minute. Long enough that reloading a permalink, or metadata and the page
 * itself asking for the same request, costs GitHub nothing; short enough that
 * a pull request someone is pushing to is not judged on yesterday's diff.
 */
const CACHE_SECONDS = 60;

/** What the brake says when this address has had its share of GitHub. */
const THROTTLE_MESSAGE =
  'Too many pull requests fetched from this address. Try again in a few minutes.';

/**
 * Fetch a public pull request and hand back everything a review opens with.
 *
 * Failure is a value, not a throw: every way this can fail is something to put
 * on screen — a private repository, a rate limit, a URL that is not a pull
 * request — and a rejected action would only reach the browser as a digest
 * with the reason stripped out.
 *
 * Two callers share it and must not count twice against either limit: the
 * page's own server action, and the permalink route, whose `generateMetadata`
 * and whose body both want the same request. React's `cache` is what makes
 * those one call per request; the minute-long cache underneath is what makes a
 * reload one call per minute. The throttle sits inside the miss, so a cached
 * answer is free and only a real trip to GitHub is counted.
 */
export const loadPullRequest = cache(
  async (url: string): Promise<PullRequestAnswer> => {
    try {
      const { value: pr } = await cached(
        cacheKey('pull-request', url),
        'pull request',
        async () => {
          if (throttled(callerIp(await headers()))) {
            throw new Error(THROTTLE_MESSAGE);
          }
          return fetchPullRequest(url);
        },
        CACHE_SECONDS,
      );
      return {
        ok: true,
        pr: {
          body: pr.body.trim()
            ? createElement(PullRequestBody, { body: pr.body })
            : null,
          bodyText: pr.body,
          changedFiles: pr.changedFiles,
          diff: pr.diff,
          title: pr.title,
          url: pr.url,
        },
      };
    } catch (err) {
      return {
        error:
          err instanceof Error
            ? err.message
            : 'Could not fetch that pull request.',
        ok: false,
      };
    }
  },
);
