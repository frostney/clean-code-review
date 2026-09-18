'use server';

import { loadPullRequest, type PullRequestAnswer } from '@/lib/pull-request';

/**
 * The browser's way to a pull request. GitHub sends no CORS headers for a
 * diff, so the fetch has to happen here; everything it does — the throttle,
 * the minute-long cache, rendering the description to a node — lives in
 * `lib/pull-request`, because the permalink route opens the same review from
 * the server and the two must not drift apart.
 */
export async function openPullRequest(url: string): Promise<PullRequestAnswer> {
  return loadPullRequest(url);
}

export type { PullRequestAnswer, PullRequestPayload } from '@/lib/pull-request';
