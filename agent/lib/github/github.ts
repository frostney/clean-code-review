/**
 * Server-only: GitHub sends no CORS headers for diffs. GITHUB_TOKEN is
 * optional and only raises the rate limit.
 */
export interface PullRequestReview {
  url: string;
  title: string;
  body: string;
  diff: string;
  /** Empty when GitHub sent none; it is decoration only. */
  avatarUrl: string;
  /** GitHub's total; callers derive the skipped-file count from it. */
  changedFiles: number;
}

// Dots are allowed (`.github` is a repository), but not "." or ".." alone.
const NAME = '(?!\\.\\.?\\/)[A-Za-z0-9_.-]+';
const PR_URL = new RegExp(
  `^https?:\\/\\/(?:www\\.)?github\\.com\\/(${NAME})\\/(${NAME})\\/pull\\/(\\d+)(?:[/?#].*)?$`,
);

/** GitHub allows a repository 100 characters and an owner 39. */
const MAX_NAME_LENGTH = 100;

/** Rejects leading zeros: `/pull/0002` would be a second cache entry and fetch for PR 2. */
const NUMBER = /^[1-9][0-9]{0,8}$/;

export const NOT_A_PULL_REQUEST =
  'That is not a GitHub pull request URL (expected github.com/owner/repo/pull/123).';

export interface PullRequestRef {
  /** Lower-cased: GitHub matches owners and repositories case-insensitively. */
  owner: string;
  repo: string;
  number: number;
  /** Canonical; the cache is keyed on it. */
  url: string;
}

/**
 * Canonicalises so every spelling GitHub accepts for one PR shares a cache
 * entry. Spellings GitHub would never write (leading zeros, invalid names)
 * return null rather than being normalised.
 */
export function parsePullRequest(input: string): PullRequestRef | null {
  const m = PR_URL.exec(input.trim());
  if (!m) {
    return null;
  }
  const owner = m[1].toLowerCase();
  // A clone URL's `.git` is not part of the name; the input field strips it too.
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

/** Far past anything the page can judge; refuse rather than buffer. */
const MAX_DIFF_BYTES = 4_000_000;

const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY = 429;

/** Null past `max` bytes. GitHub sends diffs chunked, so content-length cannot be relied on. */
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
    // Do not await: under Next's patched fetch, cancelling an unread body
    // never settles and would hang until the function times out.
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
    base?: { repo?: { owner?: { avatar_url?: string } } };
  };
  const text = await readCapped(diff, MAX_DIFF_BYTES);
  if (text === null) {
    throw new Error("That pull request's diff is too large to judge here.");
  }
  return {
    avatarUrl: json.base?.repo?.owner?.avatar_url ?? '',
    body: json.body ?? '',
    changedFiles: json.changed_files ?? 0,
    diff: text,
    title: json.title ?? `${ref.owner}/${ref.repo}#${ref.number}`,
    url: json.html_url ?? ref.url,
  };
}
