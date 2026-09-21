// Its own module rather than inside `PullRequestField`: `ReviewProvider` needs
// it, and the field imports the provider.

export const HOST_PREFIX = 'github.com/';
export const PULL_INFIX = '/pull/';

const PR_URL =
  /(?:^|\/\/)(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i;

/** A bare `owner/repo/pull/123`. */
const PR_PATH = /^([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/i;

export interface PullRequestAddress {
  /** `owner/repo`, typed as one string. */
  repo: string;
  number: string;
}

export const NO_ADDRESS: PullRequestAddress = { number: '', repo: '' };

// Null for a partial address: a half-typed `owner/` is not a mistake.
export function splitPullRequest(pasted: string): PullRequestAddress | null {
  const text = pasted.trim();
  const url = PR_URL.exec(text) ?? PR_PATH.exec(text);

  return url ? { number: url[2], repo: url[1].replace(/\.git$/i, '') } : null;
}

export function pullRequestUrl(repo: string, number: string): string {
  const owner = repo.trim().replace(/^\/+|\/+$/g, '');

  return `https://${HOST_PREFIX}${owner}${PULL_INFIX}${number.trim()}`;
}

export function pullRequestPath(url: string): string | null {
  const parts = splitPullRequest(url);

  // Lower case, matching the server's cache keys and canonical link.
  return parts
    ? `/${parts.repo.toLowerCase()}${PULL_INFIX}${parts.number}`
    : null;
}
