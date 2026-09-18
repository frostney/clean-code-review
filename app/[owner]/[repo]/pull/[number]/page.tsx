import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isGitHubName } from '@/agent/lib/github';
import { Shell } from '@/app/_components/Shell';
import { pullRequestUrl } from '@/lib/address';
import { loadPullRequest, type PullRequestAnswer } from '@/lib/pull-request';

/**
 * A pull request, at the address this site keeps it at.
 *
 * It renders the same page `/` does, with the review already open: the diff is
 * fetched here rather than after the JavaScript lands, so a link someone was
 * sent is a review in the first paint. Fetching is the one thing this route
 * adds, and it is shared with the server action the field calls — same
 * throttle, same minute-long cache, same rendered description.
 *
 * A failure is not a 500. The pull request may be private, deleted or simply
 * rate-limited, and none of those is a broken page: the landing view comes
 * back with the reason across the top, exactly as it would had the address
 * been typed into the field.
 */
interface Params {
  owner: string;
  repo: string;
  number: string;
}

/** Only digits. `/vercel/ai/pull/abc` is not a pull request that exists. */
const NUMBER_ONLY = /^\d+$/;

/**
 * What the URL names, or nothing. Route parameters are whatever was typed into
 * the address bar, so they are checked against what GitHub could have named
 * before they are made into a request to it.
 */
function addressOf(params: Params): string | null {
  const named =
    isGitHubName(params.owner) &&
    isGitHubName(params.repo) &&
    NUMBER_ONLY.test(params.number);
  return named
    ? pullRequestUrl(`${params.owner}/${params.repo}`, params.number)
    : null;
}

/** As many characters of the description as a search result would show. */
const DESCRIPTION_CHARS = 160;

/**
 * The author's own words, flattened to one line and cut to the length a result
 * shows. Markdown is left as it was written: stripping it properly would mean
 * parsing it, and what is quoted here is a sentence or two of prose.
 */
function describe(answer: PullRequestAnswer, fallback: string): string {
  const body = answer.ok ? answer.pr.bodyText.replace(/\s+/g, ' ').trim() : '';
  if (!body) {
    return fallback;
  }
  return body.length > DESCRIPTION_CHARS
    ? `${body.slice(0, DESCRIPTION_CHARS).trimEnd()}…`
    : body;
}

/**
 * What this page tells a crawler: the pull request's own title, and not to
 * index it. The reviews are worth reading and worth linking to, but this site
 * is not going to become a search engine's copy of other people's pull
 * requests. The Open Graph image stays the root's, so a link still previews.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const named = await params;
  const url = addressOf(named);
  const robots = { follow: false, index: false };
  if (!url) {
    return { robots };
  }
  const answer = await loadPullRequest(url);
  const name = `${named.owner}/${named.repo}#${named.number}`;
  return {
    description: describe(answer, `A Clean Code review of ${name}.`),
    robots,
    title: answer.ok ? answer.pr.title : name,
  };
}

export default async function PullRequestPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const named = await params;
  const url = addressOf(named);
  if (!url) {
    notFound();
  }
  const answer = await loadPullRequest(url);
  return (
    <Shell
      address={{ number: named.number, repo: `${named.owner}/${named.repo}` }}
      error={answer.ok ? null : answer.error}
      pullRequest={answer.ok ? answer.pr : null}
    />
  );
}
