/**
 * Recently merged pull requests for the landing page's example chips.
 *
 * There is no GitHub token, so every reader spends one anonymous budget. The
 * two halves of it are counted apart: the search call comes from GitHub's
 * search limit (10 a minute), and each pull-request call from the core limit
 * (60 an hour), which the reader's own pasted pull request also draws on. A
 * refresh is therefore capped at one search call plus `MAX_DETAIL_CALLS`
 * pull-request calls, bounded by a deadline as well as a count.
 *
 * The answer is shared, not per visitor, but only as far as the store reaches:
 * the Vercel Runtime Cache is per region, so `RECENT_REFRESH_SECONDS` is one
 * refresh per region, not one worldwide, and a CDN entry in front of the route
 * is best effort on top of that. Without a shared store there is nothing to
 * stop every instance walking, so this module refuses to call GitHub at all
 * rather than degrade to per-instance memory — the same fail-closed rule
 * `../spend/spend.ts` applies to the spend counters.
 *
 * Merged only, and only from `REPOSITORIES`: a merged pull request's title and
 * diff have been through the maintainers of a repository we picked, and the
 * fixed list means the search can never hand the page a stranger's repository.
 * Whatever this returns is rendered under our name, so the title is clamped
 * here — this is the last place that can.
 */
import { cacheGetStrict, cacheSetStrict } from '../infra/cache';
import { parsePullRequest } from './github';

/** What a chip needs. Flat and small: it is serialised to every visitor. */
export interface RecentPullRequest {
  /** `owner/repo`, in the repository's own casing. */
  repo: string;
  number: number;
  title: string;
  url: string;
}

/**
 * Large, actively maintained projects a reader is likely to recognise, each
 * merging enough code that a fortnight is never empty. GitHub matches owners
 * and repositories case-insensitively, so the casing here is only what the
 * chip shows.
 */
const REPOSITORIES = [
  'facebook/react',
  'vercel/next.js',
  'microsoft/TypeScript',
  'nodejs/node',
  'denoland/deno',
  'vitejs/vite',
  'withastro/astro',
  'oven-sh/bun',
] as const;

const REPOSITORY_BY_PATH = new Map(
  REPOSITORIES.map((name) => [name.toLowerCase(), name as string]),
);

const REPOSITORY_FILTER = REPOSITORIES.map((name) => `repo:${name}`).join(' ');

const RECENT_DAYS = 14;
const MS_PER_DAY = 86_400_000;

/** `2026-09-07`, the only date format the search accepts. */
const DATE_CHARS = 10;

/**
 * `sort=updated` is the closest the issue search comes to "recently merged",
 * and on its own it floats year-old pull requests up on a new comment, so the
 * window is a qualifier as well: without it most of the candidate list is
 * spent on merges the filter then throws away.
 *
 * Exported so a test can hold it under GitHub's 256-character query limit.
 */
export function searchQuery(now: Date): string {
  const since = new Date(now.getTime() - RECENT_DAYS * MS_PER_DAY)
    .toISOString()
    .slice(0, DATE_CHARS);

  return `is:pr is:merged merged:>=${since} ${REPOSITORY_FILTER}`;
}

const SEARCH_URL = 'https://api.github.com/search/issues';

/** A row of one or two chips reads as broken rather than short. */
const MIN_CHIPS = 3;
const MAX_CHIPS = 5;

/**
 * One page of the one search call, whatever its size, so a longer list costs
 * nothing. Roughly a third of a candidate list survives the filter, and the
 * busiest repository supplies most of it, so twenty candidates ran out before
 * five chips did.
 */
const CANDIDATES = 60;

/**
 * Hard ceiling per refresh, beside the one search call. Set against a measured
 * walk, not a rate: one live refresh took 13 calls to reach five chips, so a
 * ceiling below that buys a four-chip row to save one call. At
 * `RECENT_REFRESH_SECONDS` this is still at most half of GitHub's 60 core
 * calls an hour, and less if that window widens.
 */
const MAX_DETAIL_CALLS = 15;

/**
 * A repository that supplies most of a search page must not be able to spend
 * the whole ceiling on pull requests the size filter then rejects, leaving a
 * deterministic candidate set to waste the same calls every window.
 */
const MAX_CALLS_PER_REPOSITORY = 4;

/** Two from one repository already reads as a row; more crowds the rest out. */
const MAX_PER_REPOSITORY = 2;

const MIN_ADDED_LINES = 30;
const MAX_CHANGED_FILES = 24;

export const RECENT_REFRESH_SECONDS = 1_800;

/**
 * Bounds the walk in time as well as in calls: `MAX_DETAIL_CALLS` sequential
 * fetches each allowed `REQUEST_TIMEOUT_MS` would otherwise outlive the
 * invocation, and a walk killed part way through has spent its calls and
 * stored nothing.
 */
const WALK_DEADLINE_MS = 20_000;

/** A stuck call would hold the whole sequential walk, and the route with it. */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * How long a claimed window keeps other instances out. Longer than a walk can
 * run, short enough that an invocation killed mid-walk is retried soon.
 */
const CLAIM_SECONDS = 180;

const CACHE_NAME = 'recent-pull-requests';
const CACHE_KEY = CACHE_NAME;

const USER_AGENT = 'clean-code-judge';
const API_VERSION = '2022-11-28';
const GITHUB_JSON = 'application/vnd.github+json';

const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY = 429;

/** The fields the filter reads, from a search item or a pull request alike. */
interface PullRequestFacts {
  draft: boolean;
  login: string;
  userType: string;
  mergedAt: string | null;
}

export interface PullRequestDetails extends PullRequestFacts {
  additions: number;
  changedFiles: number;
  title: string;
}

export interface Candidate {
  facts: PullRequestFacts;
  number: number;
  repo: string;
  url: string;
}

/** Null skips one candidate; `rate-limited` ends the refresh. */
export type Fetched = PullRequestDetails | 'rate-limited' | null;

function isBot(facts: PullRequestFacts): boolean {
  return facts.userType === 'Bot' || facts.login.endsWith('[bot]');
}

function recentlyMerged(mergedAt: string | null, now: Date): boolean {
  const at = mergedAt === null ? Number.NaN : Date.parse(mergedAt);

  return Number.isFinite(at) && now.getTime() - at <= RECENT_DAYS * MS_PER_DAY;
}

/**
 * Everything but the size, which only the pull-request call can answer. Merged
 * only, deliberately: an open pull request's title is whatever a stranger
 * typed, and nothing but a maintainer's merge vouches for what a chip shows.
 */
function worthFetching(facts: PullRequestFacts, now: Date): boolean {
  return !facts.draft && !isBot(facts) && recentlyMerged(facts.mergedAt, now);
}

function qualifies(details: PullRequestDetails, now: Date): boolean {
  return (
    worthFetching(details, now) &&
    details.title !== '' &&
    details.additions >= MIN_ADDED_LINES &&
    details.changedFiles <= MAX_CHANGED_FILES
  );
}

/**
 * One repository supplies most of a search page, so walking the list as it
 * came spends the ceiling inside it. This keeps each repository's own order
 * and gives every repository a turn.
 */
function interleaved(candidates: Candidate[]): Candidate[] {
  const queues = new Map<string, Candidate[]>();

  for (const candidate of candidates) {
    const queue = queues.get(candidate.repo);

    if (queue) {
      queue.push(candidate);
    } else {
      queues.set(candidate.repo, [candidate]);
    }
  }
  const rounds = [...queues.values()];
  const longest = Math.max(0, ...rounds.map((queue) => queue.length));
  const out: Candidate[] = [];

  for (let round = 0; round < longest; round++) {
    for (const queue of rounds) {
      const candidate = queue[round];

      if (candidate) {
        out.push(candidate);
      }
    }
  }

  return out;
}

/** Calls spent and chips taken, per repository. */
interface Tally {
  calls: Map<string, number>;
  chips: Map<string, number>;
}

function bump(counts: Map<string, number>, repo: string): void {
  counts.set(repo, (counts.get(repo) ?? 0) + 1);
}

function atRepositoryLimit(tally: Tally, repo: string): boolean {
  return (
    (tally.chips.get(repo) ?? 0) >= MAX_PER_REPOSITORY ||
    (tally.calls.get(repo) ?? 0) >= MAX_CALLS_PER_REPOSITORY
  );
}

/**
 * Walks the candidates repository by repository, spending one `fetchDetails`
 * call on each one the cheap filter lets through, and stops at `MAX_CHIPS`, at
 * the call ceiling, at the deadline, or the moment GitHub starts refusing.
 * Returns nothing at all below `MIN_CHIPS`.
 */
export async function selectPullRequests(
  candidates: Candidate[],
  fetchDetails: (candidate: Candidate) => Promise<Fetched>,
  now = new Date(),
): Promise<RecentPullRequest[]> {
  // Wall clock, not `now`: `now` is the filter's clock and a test may fix it.
  const deadline = Date.now() + WALK_DEADLINE_MS;
  const chosen: RecentPullRequest[] = [];
  const tally: Tally = { calls: new Map(), chips: new Map() };
  let calls = 0;

  for (const candidate of interleaved(candidates)) {
    if (
      chosen.length >= MAX_CHIPS ||
      calls >= MAX_DETAIL_CALLS ||
      Date.now() > deadline
    ) {
      break;
    }
    if (
      atRepositoryLimit(tally, candidate.repo) ||
      !worthFetching(candidate.facts, now)
    ) {
      continue;
    }
    calls++;
    bump(tally.calls, candidate.repo);
    const details = await fetchDetails(candidate);

    if (details === 'rate-limited') {
      break;
    }
    if (details === null || !qualifies(details, now)) {
      continue;
    }
    bump(tally.chips, candidate.repo);
    chosen.push({
      number: candidate.number,
      repo: candidate.repo,
      title: details.title,
      url: candidate.url,
    });
  }

  return chosen.length >= MIN_CHIPS ? chosen : [];
}

interface SearchItem {
  html_url?: string;
  title?: string;
  draft?: boolean;
  user?: { login?: string; type?: string };
  pull_request?: { merged_at?: string | null };
}

interface PullRequestPayload extends SearchItem {
  additions?: number;
  changed_files?: number;
  merged_at?: string | null;
}

/**
 * Null for anything outside `REPOSITORIES`. The search cannot return one, but
 * this is the boundary that keeps a stranger's repository off the page, so it
 * checks rather than trusts, and rebuilds the URL from the name we hold rather
 * than echoing the one GitHub sent.
 */
export function candidateOf(item: SearchItem): Candidate | null {
  const ref = parsePullRequest(item.html_url ?? '');

  if (!ref) {
    return null;
  }
  const repo = REPOSITORY_BY_PATH.get(`${ref.owner}/${ref.repo}`);

  if (repo === undefined) {
    return null;
  }

  return {
    facts: {
      draft: item.draft === true,
      login: item.user?.login ?? '',
      mergedAt: item.pull_request?.merged_at ?? null,
      userType: item.user?.type ?? '',
    },
    number: ref.number,
    repo,
    url: `https://github.com/${repo}/pull/${ref.number}`,
  };
}

const MAX_TITLE_CHARS = 120;
const ELLIPSIS = '…';

/** Newlines and tabs, which a one-line chip cannot hold. */
const CONTROL_CHARS = /\p{Cc}/gu;

/**
 * Bidi overrides and other invisibles: they let a title read on screen as
 * something other than what it says, and a chip is a link we vouch for.
 */
const FORMAT_CHARS = /\p{Cf}/gu;

const WHITESPACE_RUN = /\s+/g;

function safeTitle(raw: string): string {
  const clean = raw
    .replace(CONTROL_CHARS, ' ')
    .replace(FORMAT_CHARS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
  // By code point: slicing code units would cut a surrogate pair in half.
  const points = [...clean];

  return points.length <= MAX_TITLE_CHARS
    ? clean
    : `${points.slice(0, MAX_TITLE_CHARS - 1).join('')}${ELLIPSIS}`;
}

/** Defaults are the ones that fail `qualifies`, never the ones that pass it. */
export function detailsFrom(payload: PullRequestPayload): PullRequestDetails {
  return {
    additions: payload.additions ?? 0,
    changedFiles: payload.changed_files ?? Number.POSITIVE_INFINITY,
    draft: payload.draft === true,
    login: payload.user?.login ?? '',
    mergedAt: payload.merged_at ?? null,
    title: safeTitle(payload.title ?? ''),
    userType: payload.user?.type ?? '',
  };
}

function requestHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;

  return {
    accept: GITHUB_JSON,
    'user-agent': USER_AGENT,
    'x-github-api-version': API_VERSION,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** Do not await: under Next's patched fetch, cancelling never settles. */
function drop(response: Response): void {
  response.body?.cancel().catch(() => {
    /* The socket is being dropped either way. */
  });
}

async function searchCandidates(now: Date): Promise<Candidate[]> {
  const params = new URLSearchParams({
    order: 'desc',
    per_page: String(CANDIDATES),
    q: searchQuery(now),
    sort: 'updated',
  });

  try {
    const response = await fetch(`${SEARCH_URL}?${params}`, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      drop(response);

      return [];
    }
    const json = (await response.json()) as { items?: SearchItem[] };

    return (json.items ?? [])
      .map(candidateOf)
      .filter((candidate): candidate is Candidate => candidate !== null);
  } catch {
    return [];
  }
}

async function fetchDetails(candidate: Candidate): Promise<Fetched> {
  const url = `https://api.github.com/repos/${candidate.repo}/pulls/${candidate.number}`;

  try {
    const response = await fetch(url, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // Unauthenticated reads of a public repository are refused for one reason:
    // the budget is spent (403 for the hourly limit, 429 for the secondary).
    if (
      response.status === HTTP_FORBIDDEN ||
      response.status === HTTP_TOO_MANY
    ) {
      drop(response);

      return 'rate-limited';
    }
    if (!response.ok) {
      drop(response);

      return null;
    }

    return detailsFrom((await response.json()) as PullRequestPayload);
  } catch {
    return null;
  }
}

type Trouble = 'read' | 'claim' | 'store';

const logged = new Set<Trouble>();

const TROUBLE: Record<Trouble, string> = {
  claim:
    'could not be claimed, so this refresh is skipped rather than let every instance walk at once',
  read: 'could not be read, so the row stays empty rather than spend GitHub per instance',
  store: 'could not be written, so the next reader walks again',
};

function logTrouble(kind: Trouble, err: unknown): void {
  if (logged.has(kind)) {
    return;
  }
  logged.add(kind);
  const cause = err instanceof Error ? err.message : String(err);

  console.error(
    `[recent] The recent pull request cache ${TROUBLE[kind]} (${cause}). Logged once per instance.`,
  );
}

/**
 * Takes the window before the walk rather than after it, so instances and
 * regions that miss together do not each spend a budget. The Runtime Cache has
 * no atomic write, so two claims landing within one round trip both win; this
 * narrows the stampede to a round trip, not to zero. A write that fails
 * silently in that client also reads as a claim.
 */
async function claimWindow(): Promise<boolean> {
  try {
    await cacheSetStrict(CACHE_KEY, [], CACHE_NAME, CLAIM_SECONDS);

    return true;
  } catch (err) {
    logTrouble('claim', err);

    return false;
  }
}

async function refresh(): Promise<RecentPullRequest[]> {
  if (!(await claimWindow())) {
    return [];
  }
  const now = new Date();
  const found = await selectPullRequests(
    await searchCandidates(now),
    fetchDetails,
    now,
  );

  try {
    // An empty answer is stored too: a refused refresh backs off for the
    // window instead of spending the budget again on the next reader.
    await cacheSetStrict(CACHE_KEY, found, CACHE_NAME, RECENT_REFRESH_SECONDS);
  } catch (err) {
    logTrouble('store', err);
  }

  return found;
}

let refreshing: Promise<RecentPullRequest[]> | null = null;

/**
 * Up to `MAX_CHIPS` pull requests, or none. Never throws: an empty row is the
 * answer for a failed, refused or unshared refresh as much as for a quiet
 * fortnight.
 */
export async function recentPullRequests(): Promise<RecentPullRequest[]> {
  let stored: unknown;

  try {
    stored = await cacheGetStrict(CACHE_KEY);
  } catch (err) {
    logTrouble('read', err);

    return [];
  }
  if (Array.isArray(stored)) {
    return stored as RecentPullRequest[];
  }
  // One refresh at a time within an instance; the claimed window is what holds
  // the other instances off.
  refreshing ??= refresh()
    .catch((): RecentPullRequest[] => [])
    .finally(() => {
      refreshing = null;
    });

  return await refreshing;
}
