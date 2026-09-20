/**
 * Markdown twins of every page, for `Accept: text/markdown` (acceptmarkdown.com).
 * A pure pathname-to-string lookup, so `proxy.ts` can answer before the router
 * and a permalink costs no GitHub rate limit. Every figure is imported from the
 * module that enforces it.
 */

import { parsePullRequest } from '@/agent/lib/github/github';
import {
  SESSION_WINDOW_MS,
  SESSIONS_PER_WINDOW,
} from '@/agent/lib/infra/session-facts';
import { QUESTION_COUNT } from '@/agent/lib/judging/questions';
import { REVIEW_LIMITS } from '@/agent/lib/review/review';
import { REVIEWER_MODEL } from '@/agent/lib/review/summary';
import {
  dollars,
  MCP_DAILY_BUDGET_USD,
  MCP_HOURLY_BUDGET_USD,
  PAGE_DAILY_BUDGET_USD,
  PAGE_HOURLY_BUDGET_USD,
} from '@/agent/lib/spend/budgets';
import {
  MAX_PASTE_CHARS,
  MCP_CALLS_PER_WINDOW,
  MCP_PATH,
  MCP_TOOLS,
  MCP_WINDOW_MINUTES,
} from '@/src/mcp/mcp-facts';
import { pullRequestUrl } from '@/src/pull-request/address';
import {
  GITHUB_FETCH_WINDOW_MS,
  GITHUB_FETCHES_PER_WINDOW,
} from '@/src/pull-request/throttle';

import { answerMarkdown, FAQ } from './faq-content';
import { SITE } from './site';

export const MARKDOWN_TYPE = 'text/markdown; charset=utf-8';

/**
 * By name, never by wildcard: browsers send `*\/*`. It also keeps RSC requests
 * (`text/x-component`) out, which matters because Next strips the Flight
 * headers inside a proxy, leaving Accept as the only way to tell them apart.
 */
export function wantsMarkdown(accept: string | null | undefined): boolean {
  return /(^|,)\s*text\/markdown\s*(;|,|$)/i.test(accept ?? '');
}

const url = (path: string) => `${SITE.url}${path}`;

const MS_PER_MINUTE = 60_000;
const GITHUB_FETCH_WINDOW_MINUTES = Math.round(
  GITHUB_FETCH_WINDOW_MS / MS_PER_MINUTE,
);
const SESSION_WINDOW_MINUTES = Math.round(SESSION_WINDOW_MS / MS_PER_MINUTE);

const INDEXES = [
  `- [llms.txt](${url('/llms.txt')}): this site in one paragraph, for a model.`,
  `- [sitemap.xml](${url('/sitemap.xml')}): every page meant to be indexed.`,
  `- MCP server at \`${url(MCP_PATH)}\`: the same review for an agent without a browser, over stateless Streamable HTTP. \`${MCP_TOOLS.pullRequest}\` takes a public pull request URL; \`${MCP_TOOLS.paste}\` takes a unified diff or files, up to ${MAX_PASTE_CHARS.toLocaleString('en-US')} characters. ${MCP_CALLS_PER_WINDOW} calls per ${MCP_WINDOW_MINUTES} minutes per address, and a shared model budget of ${dollars(MCP_HOURLY_BUDGET_USD)} per hour and ${dollars(MCP_DAILY_BUDGET_USD)} per UTC day; once it is spent, new reviews are refused until it resets.`,
  `- [Source](${SITE.source}): the whole application, including the question set and the prompts.`,
].join('\n');

// The cache hour is written in words: it is a duration, not a count.
const LIMITS = [
  '- Public GitHub repositories only. There is no account and nothing to sign in to.',
  `- One turn judges at most ${REVIEW_LIMITS.maxFiles} code files, the largest changes first.`,
  `- Each file is read up to ${REVIEW_LIMITS.maxCharsPerFile.toLocaleString('en-US')} characters. Anything past that is cut.`,
  `- Up to ${REVIEW_LIMITS.maxProseFiles} prose files (Markdown, plain text) are shown beside the review and never judged.`,
  '- Images, binaries, lockfiles, minified files and generated files never become a card.',
  '- Identical work comes back from a cache for one hour rather than being judged again.',
  '- Each browser tab is one agent session with its own spending cap and an hour-long lifetime.',
].join('\n');

const TITLE = `# ${SITE.name}`;

const HOME = `${TITLE}

> ${SITE.tagline}

This URL is the application. Point it at a public GitHub pull request, or paste a
unified diff or a single file, and Jev (TypeSafe's evaluation model, reached
through the Vercel AI Gateway) answers up to ${QUESTION_COUNT} questions about every code
file in the change in one call. The questions come from the chapters of Robert C.
Martin's *Clean Code*: names, functions, comments, formatting, objects and data
structures, error handling, tests, classes and smells. Every answer is a
probability or a score rather than a sentence, so a verdict is made of things a
reader can check against the code. Luna (${REVIEWER_MODEL}) then writes the prose:
one section per file from Jev's findings and that file's code, and the decision
at the top from the findings for every file and the pull request's description.

## What is on the page

An address field with \`github.com/\` already in it, a row of example pull
requests, and a paste box for a diff or a file. Opening a review replaces the
landing view with one card per file: the rows Jev was asked about, the answer to
each, and Luna's paragraph. Every example is editable, and an edit re-judges only
the file that changed.

A review of \`https://github.com/owner/repo/pull/123\` is also kept at
\`${SITE.url}/owner/repo/pull/123\`, which is a permalink worth sending to someone.

## Limits

${LIMITS}

## Pages

- [/](${SITE.url}): this page.
- [/faq](${url('/faq')}): what it judges, which models do the work, whether code is stored.
- [/privacy](${url('/privacy')}): what leaves the browser, who processes it, how long it is kept.
- [/owner/repo/pull/123](${url('/owner/repo/pull/123')}): the review of one pull request.

## Machine-readable

${INDEXES}
`;

// Built from the same `FAQ` array as the page, so the two cannot drift.
const FAQ_PAGE = `# Questions about ${SITE.name}

${FAQ.map((item) => `## ${item.q}\n\n${answerMarkdown(item.a)}`).join('\n\n')}

What leaves the browser, and how long anything is kept, is on [/privacy](${url('/privacy')}).

## Limits

${LIMITS}

## Machine-readable

${INDEXES}
`;

// The twin of `app/privacy/page.tsx`: the same facts in the same order, with
// the Vercel measurement details in the same table.
const PRIVACY = `# Privacy

Nothing here identifies you. There is no account, no database and no cookie:
there is a browser tab and the session it holds open. Nothing you paste is
written down anywhere this site keeps.

## Your code

The code you paste reaches this site's server as one agent turn. So does the
diff fetched for a pull request you name. The server sends each file through the
Vercel AI Gateway to Jev, TypeSafe's evaluation model, to be answered against up
to ${QUESTION_COUNT} questions. Jev's findings and that file's text then go to Luna
(${REVIEWER_MODEL}) through the same gateway, to be written up as the review you read.

That is the whole path: the gateway and the two model providers behind it, and
nothing else. One turn sends at most ${REVIEW_LIMITS.maxFiles} code files, each cut to
${REVIEW_LIMITS.maxCharsPerFile.toLocaleString('en-US')} characters. Up to ${REVIEW_LIMITS.maxProseFiles} prose files are shown beside them and
never sent.

## Pull requests

Public repositories only. The server fetches the pull request from GitHub with
none of your credentials, and none are ever asked for. This deployment sets no
GitHub token either, so the fetch is anonymous at both ends. A deployment can set
one to raise its own rate limit with GitHub; it would grant no access a
signed-out visitor lacks.

Fetching is rate limited by network address: ${GITHUB_FETCHES_PER_WINDOW} pull requests per
${GITHUB_FETCH_WINDOW_MINUTES} minutes. Opening a session is limited separately, ${SESSIONS_PER_WINDOW} per
${SESSION_WINDOW_MINUTES} minutes. That address is the one thing about a visitor this site's own
server holds. Each counter keeps it in one server instance's memory for the
length of its window and writes it nowhere else.

## How an address is counted

The pull request and MCP limits share one counter, so both count an IPv6 address
by its /64: one host is handed a whole /64 and can move within it. Both put a
request that arrives with no address into one shared bucket rather than letting
it pass unseen.

The session limit is separate. It counts the address as given, so a host moving
within its own /64 gets ${SESSIONS_PER_WINDOW} sessions per address it uses, and a request
with no address is not counted at all.

## Agents

Code can also arrive from an agent rather than a browser tab, through the MCP
server at \`${url(MCP_PATH)}\`. It takes the same route to the same two models in
one request, with no session and no tab, and it keeps what the page keeps and
nothing more. Each address gets ${MCP_CALLS_PER_WINDOW} calls per ${MCP_WINDOW_MINUTES} minutes.

## What a review costs

Every visitor shares one model budget: ${dollars(PAGE_HOURLY_BUDGET_USD)} per hour and ${dollars(PAGE_DAILY_BUDGET_USD)} per UTC
day. Reviews pause once it is spent and resume when it resets. The MCP server
has its own, ${dollars(MCP_HOURLY_BUDGET_USD)} per hour and ${dollars(MCP_DAILY_BUDGET_USD)} per UTC day, and refuses new reviews
once that is spent. Each budget counts what the models cost, never who asked.

## How long anything is kept

Each browser tab holds one agent session. The page clears that session's history
before every turn, so the only code it holds is the code being judged right now.
Closing the tab retires the session, and a session left alone expires after an
hour.

Judgments and written reviews are cached for an hour, keyed by a hash of exactly
what was judged, so the same file is evaluated once rather than twice. Those two
caches hold the answers and the review, not the code: the code goes into the key
and no further. A fetched pull request is cached separately for a minute, keyed
by its GitHub address. That one does hold the whole thing it fetched — the diff,
the title, the description, the author's avatar address and the number of files
changed — all of it public, from a public repository. Every cache is per
deployment region, or in one server instance's memory where there is no regional
cache. Each expires on its own and is keyed by nothing about you. A
review that comes back from one is marked "from cache".

## What Vercel measures

This site's own domain serves two scripts from Vercel. Web Analytics counts page
views. Speed Insights reads the loading and responsiveness timings the browser
already keeps, the Web Vitals, and reports how fast a page was. Neither stores
anything in your browser. Vercel describes both as anonymous: neither is tied to
a person or to a network address.

This site's own addresses are cleaned before either script sends them. The home
page, \`/faq\` and \`/privacy\` go as they are. Anything under a repository's
\`/pull\` goes as \`/[owner]/[repo]/pull/[number]\`, so the record says a review
was read and not which one. Anything else is a page that does not exist,
and goes as \`/[not-found]\`. No query and no fragment is ever sent.

| | Page views | Page speed |
|---|---|---|
| Sent | Each time a page is opened, including a review opened without reloading the page | As the page is used and when it is left |
| Always carries | The cleaned address and route, the browser and its version, the operating system and its version, the device type, the version of the script, the time | The cleaned address and route, the timing and its value, the browser and its version, the device type and operating system, the version of the script, the time Vercel received it |
| Also carries | The address of the page that linked here if it is on another site, as your browser gives it; a location worked out from the request, such as the country, region and city | The country; the network speed the browser reports; the page element the timing concerns, and for responsiveness the kind of input, such as a tap or a key press |
| Never carries | A click, the code you paste, a review | The code you paste, the names of the files, a review |
| Tells visitors apart by | A hash Vercel makes from the incoming request and resets after a day, so a visitor cannot be followed from one day to the next or from this site to another | Nothing: no identifier follows one visitor from page to page |
| Kept by Vercel for | At least the reporting window of this site's plan, one month on the free plan and one or two years on paid ones. Vercel says it may keep them longer | Not published. The dashboard this site's owner reads shows the last seven days, or longer on Vercel's paid tier |
| Vercel's own account | [What Web Analytics collects](https://vercel.com/docs/analytics/privacy-policy) | [What Speed Insights collects](https://vercel.com/docs/speed-insights/privacy-policy) |

The element is a short selector of tag names, style class names and at most one
id, such as \`main>img\` or \`#file-3>div.flex\`. No id or class here carries a
file name, a repository or words from a pull request: the file cards are
numbered, and a pull request description's ids and code-language classes are
renumbered or dropped.

## What is not here

No sign-in and no profile. No database. Nothing in local storage but the light
or dark setting this page remembers for you. No advertising and no tracking
pixels. Nothing is sold, because nothing is collected to sell.

The whole application is open source, so none of this has to be taken on trust:
[read the code](${SITE.source}).

## Machine-readable

${INDEXES}
`;

const PAGES = new Map<string, string>([
  ['/', HOME],
  ['/faq', FAQ_PAGE],
  ['/privacy', PRIVACY],
]);

function pullRequestMarkdown(owner: string, repo: string, id: number): string {
  const path = `/${owner}/${repo}/pull/${id}`;
  return `# ${owner}/${repo}#${id} · ${SITE.name}

\`${path}\` is where this site keeps its review of
\`https://github.com/${owner}/${repo}/pull/${id}\`.

Opening that address in a browser fetches the pull request from GitHub on the
server, splits its unified diff per file, and renders the review in the first
paint. This document describes the address; it does not fetch the pull request,
so reading it costs nothing against this site's GitHub rate limit and tells you
nothing about what is in the change. Open the page to read the review.

A pull request that is private, deleted or rate limited is not an error page:
the landing view comes back with the reason across the top.

The route is excluded from crawling in robots.txt and answers \`noindex\`. The
reviews are worth linking to, but this site is not going to become a search
engine's copy of other people's pull requests.

## Limits

${LIMITS}

## Machine-readable

${INDEXES}
`;
}

// The route's own parser, not a second regex, so "is there a page here" is
// answered the same way the route answers it (casing, leading zeros, names).
function pullRequestAt(pathname: string) {
  const parts = pathname.split('/');
  const [, owner, repo, pull, id] = parts;
  if (parts.length !== PULL_PATH_SEGMENTS || pull !== 'pull') {
    return null;
  }
  return parsePullRequest(pullRequestUrl(`${owner}/${repo}`, id));
}

/** `['', owner, repo, 'pull', number]` */
const PULL_PATH_SEGMENTS = 5;

function normalize(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : '/';
}

/**
 * Null means 404, so it must err towards answering. A page added under `app/`
 * must be added to `PAGES` too, alongside `app/sitemap.ts`.
 */
export function markdownFor(pathname: string): string | null {
  const path = normalize(pathname);
  const page = PAGES.get(path);
  if (page) {
    return page;
  }
  const pr = pullRequestAt(path);
  return pr ? pullRequestMarkdown(pr.owner, pr.repo, pr.number) : null;
}

export function notFoundMarkdown(pathname: string): string {
  return `# 404 Not Found

There is no page at \`${normalize(pathname)}\` on ${SITE.name}. The path matched no
route, so nothing was rendered and nothing was fetched. This response is a 404;
the address is wrong rather than temporarily unavailable.

## Pages that do exist

- [/](${SITE.url}): the application itself.
- [/faq](${url('/faq')}): what it judges and which models do the work.
- [/privacy](${url('/privacy')}): what leaves the browser and how long it is kept.
- [/owner/repo/pull/123](${url('/owner/repo/pull/123')}): the review of one public GitHub pull request.

## Machine-readable

${INDEXES}
`;
}
