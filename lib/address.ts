/**
 * A pull request's address, in the three shapes this page has to speak it: the
 * two boxes of the field, the URL GitHub is asked for, and the path this site
 * keeps that review at.
 *
 * It lives here rather than beside the field because the provider needs the
 * path too, and a field that imported the provider that imported the field
 * would be a cycle.
 */

/** The fixed parts of the address; only what is between them is ever typed. */
export const HOST_PREFIX = 'github.com/';
export const PULL_INFIX = '/pull/';

/** `github.com/vercel/ai/pull/20851`, in any of the shapes a paste takes. */
const PR_URL =
  /(?:^|\/\/)(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i;

/** A bare `owner/repo/pull/123`, which is what the old single field took. */
const PR_PATH = /^([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/i;

/** The two typed parts of a pull request's address, as the field holds them. */
export interface PullRequestAddress {
  /** `owner/repo`, as one string: it is typed as one. */
  repo: string;
  number: string;
}

/** Nothing typed yet: what the field opens with when the URL says nothing. */
export const NO_ADDRESS: PullRequestAddress = { number: '', repo: '' };

/**
 * The address inside a pasted string, or null when there is none. A paste that
 * carries the whole URL fills both boxes; anything else is left alone for the
 * repo box, because a half-typed `owner/` is not a mistake.
 */
export function splitPullRequest(pasted: string): PullRequestAddress | null {
  const text = pasted.trim();
  const url = PR_URL.exec(text) ?? PR_PATH.exec(text);
  return url ? { number: url[2], repo: url[1].replace(/\.git$/i, '') } : null;
}

/** The address the fetch is asked for, from the two parts of the field. */
export function pullRequestUrl(repo: string, number: string): string {
  const owner = repo.trim().replace(/^\/+|\/+$/g, '');
  return `https://${HOST_PREFIX}${owner}${PULL_INFIX}${number.trim()}`;
}

/** `/owner/repo/pull/123`: where this site keeps the review of that request. */
export function pullRequestPath(url: string): string | null {
  const parts = splitPullRequest(url);
  return parts ? `/${parts.repo}${PULL_INFIX}${parts.number}` : null;
}
