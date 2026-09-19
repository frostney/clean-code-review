import { headers } from 'next/headers';
import { cache, createElement, type ReactNode } from 'react';
// Holds the GitHub token, the caller's IP and the markdown pipeline.
// biome-ignore lint/correctness/noUndeclaredDependencies: `server-only` is Next's own, aliased by the bundler to next/dist/compiled/server-only; a package.json entry would pin a second copy of a module that exports nothing.
import 'server-only';

import {
  fetchPullRequest,
  NOT_A_PULL_REQUEST,
  type PullRequestReview,
  parsePullRequest,
} from '@/agent/lib/github/github';
import { cached, cacheKey } from '@/agent/lib/infra/cache';

import { PullRequestBody } from './PullRequestBody';
import { callerIp, throttled } from './throttle';

/**
 * `body` is rendered on the server so react-markdown stays out of the client
 * bundle; `bodyText` is the raw text for Luna's prompt.
 */
export interface PullRequestPayload {
  url: string;
  title: string;
  /** Empty when there is none. */
  avatarUrl: string;
  body: ReactNode;
  bodyText: string;
  diff: string;
  /** GitHub's count, including files the diff omits. */
  changedFiles: number;
}

export type PullRequestAnswer =
  | { ok: true; pr: PullRequestPayload }
  | { ok: false; error: string };

// Covers a reload and metadata-plus-page, without judging a stale diff of a
// pull request that is still being pushed to.
const CACHE_SECONDS = 60;

const THROTTLE_MESSAGE =
  'Too many pull requests fetched from this address. Try again in a few minutes.';

// Measured so an oversized diff is simply not stored, rather than a silent failed `set`.
function storedBytes(pr: PullRequestReview): number {
  return Buffer.byteLength(JSON.stringify(pr));
}

/**
 * Failure is a value: a thrown action error reaches the browser as a digest
 * with the reason stripped. React `cache` dedupes metadata and page within a
 * request; the throttle sits inside the cache miss, so only real GitHub trips
 * count. Keyed on the canonical URL, so typed casing costs nothing extra.
 */
export const loadPullRequest = cache(
  async (input: string): Promise<PullRequestAnswer> => {
    const ref = parsePullRequest(input);
    if (!ref) {
      return { error: NOT_A_PULL_REQUEST, ok: false };
    }
    try {
      const { value: pr } = await cached(
        cacheKey('pull-request', ref.url),
        'pull request',
        async () => {
          if (throttled(callerIp(await headers()))) {
            throw new Error(THROTTLE_MESSAGE);
          }
          return fetchPullRequest(ref.url);
        },
        CACHE_SECONDS,
        storedBytes,
      );
      return {
        ok: true,
        pr: {
          avatarUrl: pr.avatarUrl,
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
