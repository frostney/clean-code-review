/**
 * Every page of this site, written out as Markdown for a caller that asked for
 * Markdown.
 *
 * `acceptmarkdown.com` asks that a request carrying `Accept: text/markdown`
 * come back as a Markdown document rather than as HTML, and an agent reading
 * this site has no use for the duck, the meters or the editor. So each page
 * gets a documentation-shaped twin here: what the page is, what it does with
 * what you give it, and the limits it actually enforces.
 *
 * Nothing in this file renders a page or fetches anything. It is a lookup from
 * a pathname to a string, which is what lets `proxy.ts` answer before the
 * router has run and what keeps `/owner/repo/pull/123` from spending this
 * site's GitHub rate limit on a request that only wanted the documentation.
 *
 * Every figure below is read from the module that enforces it, so a limit
 * cannot be raised in one place and still be promised in another.
 */
import {
  dollars,
  MCP_DAILY_BUDGET_USD,
  MCP_HOURLY_BUDGET_USD,
} from '@/agent/lib/budgets';
import { parsePullRequest } from '@/agent/lib/github';
import { QUESTION_COUNT } from '@/agent/lib/questions';
import { REVIEW_LIMITS } from '@/agent/lib/review';
import { REVIEWER_MODEL } from '@/agent/lib/summary';

import { pullRequestUrl } from './address';
import { answerMarkdown, FAQ } from './faq';
import {
  MAX_PASTE_CHARS,
  MCP_CALLS_PER_WINDOW,
  MCP_PATH,
  MCP_TOOLS,
  MCP_WINDOW_MINUTES,
} from './mcp-limits';
import { SITE } from './site';

/** The one content type this module's output may be served as. */
export const MARKDOWN_TYPE = 'text/markdown; charset=utf-8';

/**
 * True when the caller asked for Markdown by name.
 *
 * By name, and never by wildcard: a browser sends
 * `text/html,…,*\/*;q=0.8`, and reading that as "Markdown is acceptable"
 * would hand the whole web a text file instead of the page. The same strictness
 * is what keeps React's own navigations out of here — an RSC request asks for
 * `text/x-component`, never for this — which matters because Next strips its
 * Flight headers from the request inside a proxy, so the Accept header is the
 * only thing left to tell the two apart.
 */
export function wantsMarkdown(accept: string | null | undefined): boolean {
  return /(^|,)\s*text\/markdown\s*(;|,|$)/i.test(accept ?? '');
}

const url = (path: string) => `${SITE.url}${path}`;

/** The indexes and the endpoint an agent should be pointed at from anywhere on the site. */
const INDEXES = [
  `- [llms.txt](${url('/llms.txt')}): this site in one paragraph, for a model.`,
  `- [sitemap.xml](${url('/sitemap.xml')}): every page meant to be indexed.`,
  `- MCP server at \`${url(MCP_PATH)}\`: the same review for an agent without a browser, over stateless Streamable HTTP. \`${MCP_TOOLS.pullRequest}\` takes a public pull request URL; \`${MCP_TOOLS.paste}\` takes a unified diff or files, up to ${MAX_PASTE_CHARS.toLocaleString('en-US')} characters. ${MCP_CALLS_PER_WINDOW} calls per ${MCP_WINDOW_MINUTES} minutes per address, and a shared model budget of ${dollars(MCP_HOURLY_BUDGET_USD)} per hour and ${dollars(MCP_DAILY_BUDGET_USD)} per UTC day; once it is spent, new reviews are refused until it resets.`,
  `- [Source](${SITE.source}): the whole application, including the question set and the prompts.`,
].join('\n');

/**
 * What this site will and will not do with a change, in the numbers the code
 * holds. `agent/lib/review.ts` owns the caps; the hour is
 * `agent/lib/cache.ts`'s and is said in words because it is a duration, not a
 * quantity the reader is counting against.
 */
const LIMITS = [
  '- Public GitHub repositories only. There is no account and nothing to sign in to.',
  `- One turn judges at most ${REVIEW_LIMITS.maxFiles} code files, the largest changes first.`,
  `- Each file is read up to ${REVIEW_LIMITS.maxCharsPerFile.toLocaleString('en-US')} characters. Anything past that is cut.`,
  `- Up to ${REVIEW_LIMITS.maxProseFiles} prose files (Markdown, plain text) are shown beside the review and never judged.`,
  '- Images, binaries, lockfiles, minified files and generated files never become a card.',
  '- Identical work comes back from a cache for one hour rather than being judged again.',
  '- Each browser tab is one agent session with its own spending cap and an hour-long lifetime.',
].join('\n');

/** The header every one of these documents opens with. */
const TITLE = `# ${SITE.name}`;

const HOME = `${TITLE}

> ${SITE.tagline}

This URL is the application. Point it at a public GitHub pull request, or paste a
unified diff or a single file, and Jev (TypeSafe's evaluation model, reached
through the Vercel AI Gateway) answers ${QUESTION_COUNT} questions about every code file
in the change in one call. The questions come from the chapters of Robert C.
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

/**
 * `/faq` for an agent: the same answers the page shows, from the same array,
 * with the page's linked phrases as Markdown links, so this copy cannot drift
 * from the one on screen.
 */
const FAQ_PAGE = `# Questions about ${SITE.name}

${FAQ.map((item) => `## ${item.q}\n\n${answerMarkdown(item.a)}`).join('\n\n')}

What leaves the browser, and how long anything is kept, is on [/privacy](${url('/privacy')}).

## Limits

${LIMITS}

## Machine-readable

${INDEXES}
`;

const PRIVACY = `# Privacy

There is no account, no database and no cookie on this site. Nothing you paste
is written down anywhere this site controls, and nothing is associated with you,
because there is no you: there is a browser tab and the session it holds open.
The one thing measured is how fast the pages load, with Vercel Speed Insights,
and what that sends is described below.

## What leaves the browser

The code you paste, or the diff fetched for the pull request you named, is sent
to this site's server as the message of one agent turn. The server sends each
file to Jev through the Vercel AI Gateway to be answered, and sends Jev's
findings plus the file's text to Luna, through the same gateway, to be written
up. That is the whole path. Your code reaches the gateway and the two model
providers behind it, and nothing else.

Code can also arrive from an agent, through the MCP server at
\`${url(MCP_PATH)}\`. That path takes the same route to the same two models in
a single request, with no session and no browser tab. It keeps what the page
keeps: the same one-hour cache of answers and reviews, and a count of calls per
network address, ${MCP_CALLS_PER_WINDOW} per ${MCP_WINDOW_MINUTES} minutes, held in one server instance's memory.
It also has a model budget that every caller shares, ${dollars(MCP_HOURLY_BUDGET_USD)} per hour and
${dollars(MCP_DAILY_BUDGET_USD)} per UTC day. Once it is spent, the endpoint refuses new reviews until it
resets. The budget is a running total of what the models cost, and it holds nothing
about who called.

## How long anything is kept

Each browser tab holds one agent session. The session's history is cleared before
every turn, so the only code it holds is the code being judged right now. Closing
the tab retires the session, and a session left alone expires after an hour.

Answers are cached for one hour, keyed by a hash of exactly what was judged, so
that judging the same file twice costs one evaluation rather than two. The cache
holds the code that was judged and the answers that came back. It is per region,
it expires on its own, and it is not keyed by anything about you.

## Pull requests

Only public repositories can be read. The server fetches the pull request from
GitHub with no credentials of yours; an optional token on the server raises this
site's own rate limit with GitHub and is never yours. Fetching is rate limited
per network address, which is the one thing about a visitor this site's server holds in
memory at all, and it holds it for minutes, in one server instance's memory, to
decide whether to fetch again.

## How fast the page loads

This site measures how fast its pages load for the people using them, with
Vercel Speed Insights. A small script from Vercel, served from this site's own
domain, reads the loading and responsiveness timings the browser already keeps
(the Web Vitals) and sends them to Vercel as the page is used and when it is left.

Each measurement carries the timing and its value, the address and the route of
the page it was taken on, the page element it concerns (as a selector, such as
\`main > img\`), the browser and its version, the device type and operating
system, the network speed the browser reports, the country, the version of the
Speed Insights script, and the time Vercel received it. For a review opened
from a pull request, the address names that public repository and the pull
request number. The responsiveness timing also names the kind of input it
measured, such as a tap or a key press, along with the element. Code you paste,
the files and the reviews are never part of it.

The script sets no cookie and stores nothing in your browser. Vercel describes
the measurements as anonymous: they are not tied to a visitor or to a network
address, and nothing in them would let anyone follow one visitor from page to
page or say who they are. Vercel does not publish how long it keeps them. The
dashboard this site's owner reads them in shows the last seven days, or longer
on Vercel's paid tier.

[Vercel's own account of what Speed Insights collects](https://vercel.com/docs/speed-insights/privacy-policy).

## What is not here

No sign-in. No profile. No database. No advertising and no tracking pixels, and
nothing that records who visits: the one measurement is the page speed above. Nothing is sold, because there is nothing collected to sell.

## Machine-readable

${INDEXES}
`;

/** The static pages, by the exact path each is served at. */
const PAGES = new Map<string, string>([
  ['/', HOME],
  ['/faq', FAQ_PAGE],
  ['/privacy', PRIVACY],
]);

/** The permalink route's document, written from the address and nothing else. */
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

/**
 * The pull request this pathname names, in the one spelling GitHub would have
 * written, or null.
 *
 * It goes through the same parser the route itself uses rather than a second
 * regular expression, so that "is there a page here" is answered identically on
 * both sides. A capitalisation the route renders is a capitalisation this
 * answers for, and a spelling the route sends to `notFound()` — a leading zero
 * in the number, a segment that is not a GitHub name — is one this calls
 * unknown too.
 */
function pullRequestAt(pathname: string) {
  const parts = pathname.split('/');
  const [, owner, repo, pull, id] = parts;
  if (parts.length !== PULL_PATH_SEGMENTS || pull !== 'pull') {
    return null;
  }
  return parsePullRequest(pullRequestUrl(`${owner}/${repo}`, id));
}

/** `['', owner, repo, 'pull', number]`: the shape of a permalink, split. */
const PULL_PATH_SEGMENTS = 5;

/** A path with its trailing slash removed, because `/privacy/` is `/privacy`. */
function normalize(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : '/';
}

/**
 * This page as Markdown, or null when the site has no page at that path.
 *
 * Null is what produces a 404, so it has to be wrong in the safe direction: a
 * real page answered as "not found" would tell an agent this site is smaller
 * than it is. Every static page is listed in `PAGES` above by the exact path
 * `app/` serves it at, and the one dynamic route is resolved by its own parser,
 * so the two lists cannot disagree about a spelling. Adding a page under `app/`
 * means adding it here — which is the same edit the sitemap already asks for,
 * and this file sits beside it for that reason.
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

/**
 * What a path that names nothing gets: the error in words, and the two indexes
 * that list what does exist, so that a wrong guess is one fetch from a right
 * one.
 */
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
