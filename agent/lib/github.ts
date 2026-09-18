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

// GitHub names: alphanumerics, hyphens, underscores and dots, never "." or ".." alone.
const NAME = '[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*';
const PR_URL = new RegExp(
  `^https?:\\/\\/(?:www\\.)?github\\.com\\/(${NAME})\\/(${NAME})\\/pull\\/(\\d+)(?:[/?#].*)?$`,
);
const NAME_ONLY = new RegExp(`^${NAME}$`);

/** GitHub allows a repository 100 characters and an owner 39. */
const MAX_NAME_LENGTH = 100;

/**
 * Could GitHub have given an owner or a repository this name? What arrives in
 * a route's parameters is whatever was typed into the address bar, and a
 * segment that is not a name is a page that does not exist rather than a fetch
 * worth making.
 */
export function isGitHubName(value: string): boolean {
  return value.length <= MAX_NAME_LENGTH && NAME_ONLY.test(value);
}

function parsePullRequestUrl(
  input: string,
): { owner: string; repo: string; number: number } | null {
  const m = PR_URL.exec(input.trim());
  if (!m) {
    return null;
  }
  return { number: Number(m[3]), owner: m[1], repo: m[2] };
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
  const ref = parsePullRequestUrl(input);
  if (!ref) {
    throw new Error(
      'That is not a GitHub pull request URL (expected github.com/owner/repo/pull/123).',
    );
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
  const fail = async (message: string): Promise<never> => {
    // Release both sockets before giving up.
    await Promise.allSettled([meta.body?.cancel(), diff.body?.cancel()]);
    throw new Error(message);
  };
  if (meta.status === HTTP_NOT_FOUND) {
    await fail(
      'Pull request not found. Private repositories are not supported.',
    );
  }
  if (meta.status === HTTP_FORBIDDEN || meta.status === HTTP_TOO_MANY) {
    await fail('GitHub rate limit reached. Try again in a few minutes.');
  }
  if (!meta.ok) {
    await fail(`GitHub returned ${meta.status} for the pull request.`);
  }
  if (!diff.ok) {
    await fail(`GitHub returned ${diff.status} for the diff.`);
  }
  const length = Number(diff.headers.get('content-length') ?? 0);
  if (length > MAX_DIFF_BYTES) {
    await fail("That pull request's diff is too large to judge here.");
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
    url: json.html_url ?? input.trim(),
  };
}
