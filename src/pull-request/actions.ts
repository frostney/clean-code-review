'use server';

import { loadPullRequest, type PullRequestAnswer } from './pull-request';

/**
 * GitHub sends no CORS headers for a diff, so the fetch runs on the server.
 * The logic lives in `./pull-request`, shared with the permalink route.
 */
export async function openPullRequest(url: string): Promise<PullRequestAnswer> {
  return loadPullRequest(url);
}

export type { PullRequestAnswer, PullRequestPayload } from './pull-request';
