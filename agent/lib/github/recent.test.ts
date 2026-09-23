/**
 * The selection walk and the two boundaries either side of it, against
 * fixtures: nothing here touches the network. What matters is what a refresh
 * costs — a call is a slice of one anonymous hourly budget shared by every
 * reader and by the pull request a reader pastes — that a refusal or a quiet
 * fortnight ends as an empty row rather than a short one, and that nothing
 * outside the repository list can reach the page.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cacheGetStrict, cacheSetStrict } from '../infra/cache';
import {
  type Candidate,
  candidateOf,
  detailsFrom,
  type Fetched,
  type PullRequestDetails,
  RECENT_REFRESH_SECONDS,
  recentPullRequests,
  refreshRecentPullRequests,
  type StoredList,
  searchQuery,
  selectPullRequests,
  storedFrom,
} from './recent';

/** GitHub rejects a search query longer than this. */
const MAX_QUERY_CHARS = 256;

const MS_PER_DAY = 86_400_000;

const NOW = new Date('2026-09-21T12:00:00Z');

const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();

let nextNumber = 1;

function candidate(
  repo: string,
  facts: Partial<Candidate['facts']> = {},
): Candidate {
  const number = nextNumber++;

  return {
    facts: {
      association: 'CONTRIBUTOR',
      draft: false,
      login: 'contributor',
      updatedAt: daysAgo(1),
      userType: 'User',
      ...facts,
    },
    number,
    repo,
    url: `https://github.com/${repo}/pull/${number}`,
  };
}

function detailsOf(
  from: Candidate,
  overrides: Partial<PullRequestDetails> = {},
): PullRequestDetails {
  return {
    ...from.facts,
    additions: 120,
    changedFiles: 4,
    title: `Change ${from.number}`,
    ...overrides,
  };
}

interface Counted {
  calls: Candidate[];
  fetch: (candidate: Candidate) => Promise<Fetched>;
}

function counted(answer: (candidate: Candidate) => Fetched): Counted {
  const calls: Candidate[] = [];

  return {
    calls,
    async fetch(candidate) {
      calls.push(candidate);

      return answer(candidate);
    },
  };
}

/* --- The query --- */

test('the search query fits what GitHub will accept', () => {
  const query = searchQuery(NOW);

  assert.ok(
    query.length <= MAX_QUERY_CHARS,
    `the query is ${query.length} characters`,
  );
  assert.match(query, /updated:>=2026-09-07\b/);
  // Open, and never a draft: the two the row exists to show.
  assert.match(query, /\bis:open\b/);
  assert.match(query, /\bdraft:false\b/);
});

test('every repository on the list is in the query', () => {
  const query = searchQuery(NOW);

  for (const repo of [
    'facebook/react',
    'vercel/next.js',
    'microsoft/TypeScript',
    'nodejs/node',
    'denoland/deno',
    'vitejs/vite',
    'withastro/astro',
    'oven-sh/bun',
  ]) {
    assert.ok(query.includes(`repo:${repo}`), `${repo} is not in the query`);
  }
});

/* --- The boundary that keeps a stranger's repository off the page --- */

const searchItem = (htmlUrl: string) => ({
  author_association: 'CONTRIBUTOR',
  draft: false,
  html_url: htmlUrl,
  title: 'A change',
  updated_at: daysAgo(1),
  user: { login: 'contributor', type: 'User' },
});

test('a repository that is not on the list is refused', () => {
  for (const url of [
    'https://github.com/a-stranger/their-repo/pull/1',
    'https://github.com/facebook/not-react/pull/1',
    'https://github.com/notfacebook/react/pull/1',
    'https://evil.example/facebook/react/pull/1',
    'https://github.com/facebook/react/issues/1',
    'not a url at all',
    '',
  ]) {
    assert.equal(candidateOf(searchItem(url)), null, url);
  }
});

test('a listed repository keeps its own casing and a rebuilt url', () => {
  // GitHub matches case-insensitively, so the casing comes from our list and
  // the url is built from it, never echoed back from the search item.
  const found = candidateOf(
    searchItem('https://github.com/Microsoft/TypeScript/pull/1234?w=1'),
  );

  assert.deepEqual(found, {
    facts: {
      association: 'CONTRIBUTOR',
      draft: false,
      login: 'contributor',
      updatedAt: daysAgo(1),
      userType: 'User',
    },
    number: 1234,
    repo: 'microsoft/TypeScript',
    url: 'https://github.com/microsoft/TypeScript/pull/1234',
  });
});

/* --- The other boundary: what the pull request call is believed for --- */

test('a payload missing everything fails the filter rather than passing it', () => {
  assert.deepEqual(detailsFrom({}), {
    additions: 0,
    association: '',
    changedFiles: Number.POSITIVE_INFINITY,
    draft: false,
    login: '',
    title: '',
    updatedAt: null,
    userType: '',
  });
});

test('a title is stripped of what a chip cannot show and cannot vouch for', () => {
  assert.equal(
    detailsFrom({ title: '  fix:\tthe\nthing  ' }).title,
    'fix: the thing',
  );
  // A right-to-left override can make a title read as something else entirely.
  assert.equal(detailsFrom({ title: 'fix: ‮gnp.exe‬' }).title, 'fix: gnp.exe');
  const long = detailsFrom({ title: 'a'.repeat(400) }).title;

  assert.equal([...long].length, 120);
  assert.ok(long.endsWith('…'));
});

/* --- The walk --- */

test('it stops at five, one call apiece', async () => {
  const candidates = ['a/one', 'b/two', 'c/three', 'd/four', 'e/five'].flatMap(
    (repo) => [candidate(repo), candidate(repo)],
  );
  const fetcher = counted((c) => detailsOf(c));
  const chosen = await selectPullRequests(candidates, fetcher.fetch, NOW);

  assert.equal(chosen.length, 5);
  assert.equal(fetcher.calls.length, 5);
  assert.deepEqual(chosen[0], {
    number: candidates[0].number,
    repo: 'a/one',
    title: `Change ${candidates[0].number}`,
    url: candidates[0].url,
  });
});

test('no more than two chips come from one repository', async () => {
  const candidates = [
    candidate('a/one'),
    candidate('a/one'),
    candidate('a/one'),
    candidate('b/two'),
    candidate('c/three'),
  ];
  const fetcher = counted((c) => detailsOf(c));
  const chosen = await selectPullRequests(candidates, fetcher.fetch, NOW);

  assert.equal(chosen.filter((pr) => pr.repo === 'a/one').length, 2);
  assert.equal(chosen.length, 4);
  // The third from `a/one` is never fetched.
  assert.equal(fetcher.calls.length, 4);
});

test('one busy repository cannot spend the whole ceiling', async () => {
  // What the reviewer fed it: a deterministic candidate set from one
  // repository, none of it judgeable. The same twenty calls every window,
  // for an empty row, is the failure this bounds.
  const candidates = Array.from({ length: 40 }, () => candidate('busy/repo'));
  const fetcher = counted((c) => detailsOf(c, { additions: 1 }));

  assert.deepEqual(
    await selectPullRequests(candidates, fetcher.fetch, NOW),
    [],
  );
  assert.equal(fetcher.calls.length, 4);
});

test('the walk takes a turn from each repository rather than draining one', async () => {
  const candidates = [
    ...Array.from({ length: 10 }, () => candidate('busy/repo')),
    candidate('quiet/one'),
    candidate('quiet/two'),
  ];
  const fetcher = counted((c) => detailsOf(c));
  const chosen = await selectPullRequests(candidates, fetcher.fetch, NOW);

  assert.deepEqual(
    chosen.map((pr) => pr.repo),
    ['busy/repo', 'quiet/one', 'quiet/two', 'busy/repo'],
  );
});

test('drafts and bots are dropped before they cost a call', async () => {
  const candidates = [
    candidate('a/one', { draft: true }),
    candidate('b/two', { userType: 'Bot' }),
    candidate('c/three', { login: 'renovate[bot]' }),
    candidate('d/four'),
    candidate('e/five'),
    candidate('f/six'),
  ];
  const fetcher = counted((c) => detailsOf(c));
  const chosen = await selectPullRequests(candidates, fetcher.fetch, NOW);

  assert.equal(fetcher.calls.length, 3);
  assert.deepEqual(
    chosen.map((pr) => pr.repo),
    ['d/four', 'e/five', 'f/six'],
  );
});

test('only a recent pull request from a past contributor is worth a call', async () => {
  const candidates = [
    candidate('a/one', { updatedAt: daysAgo(40) }),
    // A first pull request to this repository: nobody has vouched for them.
    candidate('b/two', { association: 'NONE' }),
    candidate('c/three'),
    candidate('d/four'),
    candidate('e/five'),
  ];
  const fetcher = counted((c) => detailsOf(c));
  const chosen = await selectPullRequests(candidates, fetcher.fetch, NOW);

  assert.equal(fetcher.calls.length, 3);
  assert.deepEqual(
    chosen.map((pr) => pr.repo),
    ['c/three', 'd/four', 'e/five'],
  );
});

test('an association nobody has named is a stranger', async () => {
  // The four that count are named; anything else, including one GitHub adds
  // after this was written, has to fail rather than pass.
  const candidates = [
    candidate('a/one', { association: 'FIRST_TIME_CONTRIBUTOR' }),
    candidate('b/two', { association: 'MANNEQUIN' }),
    candidate('c/three', { association: '' }),
    candidate('d/four', { association: 'SOME_FUTURE_ROLE' }),
    candidate('e/five', { association: 'contributor' }),
    candidate('f/six', { association: 'OWNER' }),
    candidate('g/seven', { association: 'MEMBER' }),
    candidate('h/eight', { association: 'COLLABORATOR' }),
  ];
  const fetcher = counted((c) => detailsOf(c));
  const chosen = await selectPullRequests(candidates, fetcher.fetch, NOW);

  assert.equal(fetcher.calls.length, 3);
  assert.deepEqual(
    chosen.map((pr) => pr.repo),
    ['f/six', 'g/seven', 'h/eight'],
  );
});

test('the size bounds are inclusive at both ends', async () => {
  const candidates = [
    candidate('a/one'),
    candidate('b/two'),
    candidate('c/three'),
  ];
  const fetcher = counted((c) =>
    detailsOf(c, { additions: 30, changedFiles: 24 }),
  );

  assert.equal(
    (await selectPullRequests(candidates, fetcher.fetch, NOW)).length,
    3,
  );
});

test('a pull request too small or too sprawling to judge is skipped', async () => {
  const small = candidate('a/one');
  const sprawling = candidate('b/two');
  const untitled = candidate('c/three');
  const candidates = [
    small,
    sprawling,
    untitled,
    candidate('d/four'),
    candidate('e/five'),
    candidate('f/six'),
  ];
  const fetcher = counted((c) => {
    if (c === small) {
      return detailsOf(c, { additions: 29 });
    }
    if (c === sprawling) {
      return detailsOf(c, { changedFiles: 25 });
    }

    return c === untitled ? detailsOf(c, { title: '' }) : detailsOf(c);
  });
  const chosen = await selectPullRequests(candidates, fetcher.fetch, NOW);

  assert.deepEqual(
    chosen.map((pr) => pr.repo),
    ['d/four', 'e/five', 'f/six'],
  );
});

test('the details are believed over the search item that led to them', async () => {
  const turned = candidate('a/one');
  const candidates = [
    turned,
    candidate('b/two'),
    candidate('c/three'),
    candidate('d/four'),
  ];
  const fetcher = counted((c) =>
    c === turned ? detailsOf(c, { draft: true }) : detailsOf(c),
  );
  const chosen = await selectPullRequests(candidates, fetcher.fetch, NOW);

  assert.deepEqual(
    chosen.map((pr) => pr.repo),
    ['b/two', 'c/three', 'd/four'],
  );
});

test('fewer than three qualifying is no row at all', async () => {
  const candidates = [candidate('a/one'), candidate('b/two')];
  const fetcher = counted((c) => detailsOf(c));

  assert.deepEqual(
    await selectPullRequests(candidates, fetcher.fetch, NOW),
    [],
  );
  assert.equal(fetcher.calls.length, 2);
});

test('a rate limit keeps three that already qualified', async () => {
  const candidates = Array.from({ length: 6 }, (_, index) =>
    candidate(`r${index}/repo`),
  );
  let answered = 0;
  const fetcher = counted((c) =>
    answered++ < 3 ? detailsOf(c) : 'rate-limited',
  );
  const chosen = await selectPullRequests(candidates, fetcher.fetch, NOW);

  assert.deepEqual(
    chosen.map((pr) => pr.repo),
    ['r0/repo', 'r1/repo', 'r2/repo'],
  );
  assert.equal(fetcher.calls.length, 4);
});

test('a rate limit before the third leaves nothing', async () => {
  const candidates = Array.from({ length: 6 }, (_, index) =>
    candidate(`r${index}/repo`),
  );
  let answered = 0;
  const fetcher = counted((c) =>
    answered++ < 2 ? detailsOf(c) : 'rate-limited',
  );

  assert.deepEqual(
    await selectPullRequests(candidates, fetcher.fetch, NOW),
    [],
  );
});

test('a failed call skips one candidate rather than the refresh', async () => {
  const broken = candidate('a/one');
  const candidates = [
    broken,
    candidate('b/two'),
    candidate('c/three'),
    candidate('d/four'),
  ];
  const fetcher = counted((c) => (c === broken ? null : detailsOf(c)));
  const chosen = await selectPullRequests(candidates, fetcher.fetch, NOW);

  assert.equal(chosen.length, 3);
  assert.equal(fetcher.calls.length, 4);
});

test('the call ceiling holds however long the candidate list is', async () => {
  const candidates = Array.from({ length: 20 }, (_, index) => [
    candidate(`r${index}/repo`),
    candidate(`r${index}/repo`),
  ]).flat();
  const fetcher = counted((c) => detailsOf(c, { additions: 1 }));

  assert.deepEqual(
    await selectPullRequests(candidates, fetcher.fetch, NOW),
    [],
  );
  assert.equal(fetcher.calls.length, 15);
});

/* --- Through the real cache: what the schedule stores and a reader sees --- */

const KEY = 'recent-pull-requests';
const REPOS = ['vercel/next.js', 'nodejs/node', 'oven-sh/bun'];
const HOUR = RECENT_REFRESH_SECONDS * 1_000;

const ONE_ROW = [
  { number: 1, repo: 'a/one', title: 'A change', url: 'https://x/1' },
];

/**
 * GitHub, stubbed: a search answering three qualifying pull requests from
 * three repositories, and a detail call that passes the size filter. Off
 * Vercel the cache is this process's memory, which counts as shared, so the
 * reads and writes below are the real ones.
 */
function stubGitHub(refuse = false) {
  const calls = { detail: 0, search: 0 };
  const recent = new Date().toISOString();
  const pull = (repo: string, n: number) => ({
    additions: 120,
    author_association: 'MEMBER',
    changed_files: 3,
    draft: false,
    html_url: `https://github.com/${repo}/pull/${n}`,
    title: `Change ${n}`,
    updated_at: recent,
    user: { login: 'maintainer', type: 'User' },
  });
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('/search/')) {
      calls.search++;
    } else {
      calls.detail++;
    }
    if (refuse) {
      return new Response('rate limited', { status: 403 });
    }
    if (url.includes('/search/')) {
      return Response.json({ items: REPOS.map((r, i) => pull(r, i + 1)) });
    }
    const match = /repos\/([^/]+\/[^/]+)\/pulls\/(\d+)/.exec(url);

    return Response.json(pull(match?.[1] ?? '', Number(match?.[2])));
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

async function holds(value: unknown) {
  await cacheSetStrict(KEY, value, KEY, 60);
}

const stored = (entry: Partial<StoredList> = {}): StoredList => ({
  at: Date.now() - 2 * HOUR,
  list: ONE_ROW,
  triedAt: Date.now() - 2 * HOUR,
  ...entry,
});

test('a reader gets what the schedule stored', async () => {
  await holds(stored());

  assert.deepEqual(await recentPullRequests(), ONE_ROW);
});

test('a reader never walks GitHub, even with nothing stored', async () => {
  // The walk belongs to the schedule. An empty cache is an empty row until
  // the next run, never a reader waiting on GitHub.
  for (const value of [null, ONE_ROW]) {
    await holds(value);
    const github = stubGitHub();

    try {
      assert.deepEqual(await recentPullRequests(), []);
      assert.deepEqual(github.calls, { detail: 0, search: 0 });
    } finally {
      github.restore();
    }
  }
});

test('an empty cache is walked and filled', async () => {
  await holds(null);
  const github = stubGitHub();

  try {
    await refreshRecentPullRequests();
    const after = storedFrom(await cacheGetStrict(KEY));

    assert.equal(github.calls.search, 1);
    assert.equal(after?.list.length, 3);
    assert.equal(after?.at, after?.triedAt);
  } finally {
    github.restore();
  }
});

test('the bare list an older deploy stored is replaced, not kept', async () => {
  // What the cache holds the first time this shape is deployed.
  await holds([{ number: 9, repo: 'a/one', title: 'Old', url: 'x' }]);
  const github = stubGitHub();

  try {
    await refreshRecentPullRequests();

    assert.equal(github.calls.search, 1);
    assert.equal(storedFrom(await cacheGetStrict(KEY))?.list.length, 3);
  } finally {
    github.restore();
  }
});

test('a second delivery of one cron run does not walk again', async () => {
  await holds(stored({ triedAt: Date.now() - 60_000 }));
  const github = stubGitHub();

  try {
    await refreshRecentPullRequests();

    assert.deepEqual(github.calls, { detail: 0, search: 0 });
  } finally {
    github.restore();
  }
});

test('a walk GitHub refuses keeps the row it had', async () => {
  const kept = stored();

  await holds(kept);
  const github = stubGitHub(true);

  try {
    await refreshRecentPullRequests();
    const after = storedFrom(await cacheGetStrict(KEY));

    assert.equal(github.calls.search, 1);
    assert.deepEqual(after?.list, ONE_ROW);
    // Kept, but not given a fresh life: it still goes on its own clock.
    assert.equal(after?.at, kept.at);
    assert.ok((after?.triedAt ?? 0) > kept.triedAt);
  } finally {
    github.restore();
  }
});

test('anything that is not an envelope reads as nothing stored', () => {
  for (const value of [
    ONE_ROW,
    undefined,
    null,
    'a string',
    {},
    { at: 1, triedAt: 1 },
    { at: 1, list: ONE_ROW },
    { at: null, list: ONE_ROW, triedAt: 1 },
    { at: 1, list: 'rows', triedAt: 1 },
  ]) {
    assert.equal(
      storedFrom(value),
      null,
      `${JSON.stringify(value)} is not one`,
    );
  }
  const envelope = stored();

  assert.deepEqual(storedFrom(envelope), envelope);
});

test('no shared store means no GitHub call at all', async () => {
  // Fail closed, as `../spend/spend.ts` does: per-instance memory would let
  // every instance walk and hand its answer to no one, so nothing is spent.
  const env = { ...process.env };
  const realError = console.error;
  const github = stubGitHub();

  process.env.VERCEL = '1';
  process.env.RUNTIME_CACHE_ENDPOINT = undefined;
  process.env.RUNTIME_CACHE_HEADERS = undefined;
  // It says so once per instance; the assertions below are what check it.
  console.error = () => undefined;

  try {
    await refreshRecentPullRequests();
    assert.deepEqual(await recentPullRequests(), []);
    assert.deepEqual(github.calls, { detail: 0, search: 0 });
  } finally {
    github.restore();
    console.error = realError;
    process.env = env;
  }
});
