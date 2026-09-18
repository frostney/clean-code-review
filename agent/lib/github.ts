/**
 * Fetch a public GitHub pull request as a review: its title, body and unified
 * diff. Runs on the server (GitHub does not send CORS headers for diffs), with
 * an optional GITHUB_TOKEN that only raises the rate limit.
 */
export interface PullRequestReview {
  url: string;
  title: string;
  body: string;
  diff: string;
  /** Files GitHub reports on the PR, for the "largest 24" rule and the skip list. */
  changedFiles: number;
}

// GitHub names: alphanumerics, hyphens, underscores and dots — `.github` is a
// repository — but never "." or ".." alone.
const NAME = '(?!\\.\\.?\\/)[A-Za-z0-9_.-]+';
const PR_URL = new RegExp(
  `^https?:\\/\\/(?:www\\.)?github\\.com\\/(${NAME})\\/(${NAME})\\/pull\\/(\\d+)(?:[/?#].*)?$`,
);

/** GitHub allows a repository 100 characters and an owner 39. */
const MAX_NAME_LENGTH = 100;

/**
 * A pull request's number as GitHub writes it: no leading zero, and no longer
 * than any repository will ever count to. `…/pull/0002` is a second spelling
 * of the second pull request, and a second spelling is a second cache entry
 * and a second trip to GitHub for the same page.
 */
const NUMBER = /^[1-9][0-9]{0,8}$/;

/** What a caller is told when the string it was given names nothing. */
export const NOT_A_PULL_REQUEST =
  'That is not a GitHub pull request URL (expected github.com/owner/repo/pull/123).';

/** A pull request, named the one way this site names it. */
export interface PullRequestRef {
  /** Folded to lower case: GitHub matches owners and repositories that way. */
  owner: string;
  repo: string;
  number: number;
  /** The canonical URL — what is fetched, and what the cache is keyed on. */
  url: string;
}

/**
 * The pull request a string names, in its one canonical spelling, or null.
 *
 * What arrives in a route's parameters is whatever was typed into the address
 * bar, and GitHub answers to more than one spelling of the same request:
 * `/Facebook/React/pull/2` and `/facebook/react/pull/2` are one pull request.
 * Folding them together here is what keeps them one cache entry and one fetch
 * rather than one of each per capitalisation. Anything that is not a spelling
 * GitHub itself would write — a number with a leading zero, a segment that is
 * not a name — is not normalised into one; it is nothing.
 */
export function parsePullRequest(input: string): PullRequestRef | null {
  const m = PR_URL.exec(input.trim());
  if (!m) {
    return null;
  }
  const owner = m[1].toLowerCase();
  // A clone URL's `.git` is not part of the name, and the field strips it too.
  const repo = m[2].toLowerCase().replace(/\.git$/, '');
  if (
    owner.length > MAX_NAME_LENGTH ||
    repo.length > MAX_NAME_LENGTH ||
    !NUMBER.test(m[3])
  ) {
    return null;
  }
  return {
    number: Number(m[3]),
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}/pull/${m[3]}`,
  };
}

/** 4 MB of diff is far past anything the page can judge; refuse rather than buffer. */
const MAX_DIFF_BYTES = 4_000_000;

/** The three answers from GitHub that are worth their own message. */
const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY = 429;

/** Read a body up to `max` bytes; null (and the connection released) when it runs past that. GitHub sends diffs chunked, so no content-length can be trusted. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concat(chunks, size));
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function fetchPullRequest(
  input: string,
  token = process.env.GITHUB_TOKEN,
): Promise<PullRequestReview> {
  const ref = parsePullRequest(input);
  if (!ref) {
    throw new Error(NOT_A_PULL_REQUEST);
  }
  const base = `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  const headers: Record<string, string> = {
    'user-agent': 'clean-code-judge',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const [meta, diff] = await Promise.all([
    fetch(base, {
      headers: { ...headers, accept: 'application/vnd.github+json' },
    }),
    fetch(base, {
      headers: { ...headers, accept: 'application/vnd.github.diff' },
    }),
  ]);
  const fail = (message: string): never => {
    // Release both sockets before giving up — without waiting for it. Under
    // Next's patched fetch, cancelling a body nobody has read never settles,
    // and a request that awaited it hung until the function timed out.
    for (const response of [meta, diff]) {
      response.body?.cancel().catch(() => {
        /* The socket is being dropped either way. */
      });
    }
    throw new Error(message);
  };
  if (meta.status === HTTP_NOT_FOUND) {
    fail('Pull request not found. Private repositories are not supported.');
  }
  if (meta.status === HTTP_FORBIDDEN || meta.status === HTTP_TOO_MANY) {
    fail('GitHub rate limit reached. Try again in a few minutes.');
  }
  if (!meta.ok) {
    fail(`GitHub returned ${meta.status} for the pull request.`);
  }
  if (!diff.ok) {
    fail(`GitHub returned ${diff.status} for the diff.`);
  }
  const length = Number(diff.headers.get('content-length') ?? 0);
  if (length > MAX_DIFF_BYTES) {
    fail("That pull request's diff is too large to judge here.");
  }
  const json = (await meta.json()) as {
    title?: string;
    body?: string | null;
    html_url?: string;
    changed_files?: number;
  };
  const text = await readCapped(diff, MAX_DIFF_BYTES);
  if (text === null) {
    throw new Error("That pull request's diff is too large to judge here.");
  }
  return {
    body: json.body ?? '',
    changedFiles: json.changed_files ?? 0,
    diff: text,
    title: json.title ?? `${ref.owner}/${ref.repo}#${ref.number}`,
    url: json.html_url ?? ref.url,
  };
}
