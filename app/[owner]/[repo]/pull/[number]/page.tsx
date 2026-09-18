import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { type PullRequestRef, parsePullRequest } from '@/agent/lib/github';
import { Shell } from '@/app/_components/Shell';
import { pullRequestUrl } from '@/lib/address';
import { loadPullRequest, type PullRequestAnswer } from '@/lib/pull-request';
import { SITE } from '@/lib/site';

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

/**
 * What the URL names, or nothing. Route parameters are whatever was typed into
 * the address bar, so they are put back together as the address they claim to
 * be and read by the one parser that also does the fetching: the capitals are
 * folded, the number is a number, and anything that is not a spelling GitHub
 * would have written — `/pull/0002`, `/pull/abc`, a number no repository will
 * ever reach — is a page that does not exist rather than a fetch worth making.
 */
function refOf(params: Params): PullRequestRef | null {
  return parsePullRequest(
    pullRequestUrl(`${params.owner}/${params.repo}`, params.number),
  );
}

/** `/owner/repo/pull/123`: the one address this review is kept at. */
function pathOf(ref: PullRequestRef): string {
  return `/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

/** As many characters of the description as a search result would show. */
const DESCRIPTION_CHARS = 160;

/** The two cards `app/opengraph-image.tsx` and `app/twitter-image.tsx` draw. */
const OPEN_GRAPH_IMAGE = '/opengraph-image';
const TWITTER_IMAGE = '/twitter-image';

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
 * What this page tells a crawler, and what a link to it unfurls as.
 *
 * Not to be indexed: the reviews are worth reading and worth linking to, but
 * this site is not going to become a search engine's copy of other people's
 * pull requests. Worth previewing all the same — somebody pasting the link
 * into a chat should see the pull request's own title and its first sentences,
 * which is why the Open Graph and Twitter blocks are written out here. The
 * root layout's are a description of the site, and a child that names one
 * block replaces it rather than adding to it; the image is the file
 * convention's and stays inherited.
 *
 * The canonical link is the normalised permalink, not the capitalisation that
 * was typed and not the layout's `/`.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const named = await params;
  const ref = refOf(named);
  const robots = { follow: false, index: false };
  if (!ref) {
    return { robots };
  }
  const answer = await loadPullRequest(ref.url);
  const name = `${ref.owner}/${ref.repo}#${ref.number}`;
  const title = answer.ok ? answer.pr.title : name;
  const description = describe(answer, `A Clean Code review of ${name}.`);
  const path = pathOf(ref);
  return {
    alternates: { canonical: path },
    description,
    openGraph: {
      description,
      // The site's own card, named rather than inherited: a route that writes
      // an Open Graph block replaces the layout's whole block, and the image
      // the file convention put there goes with it.
      images: [OPEN_GRAPH_IMAGE],
      locale: 'en_US',
      siteName: SITE.name,
      title,
      type: 'article',
      url: path,
    },
    robots,
    title,
    twitter: {
      card: 'summary_large_image',
      description,
      images: [TWITTER_IMAGE],
      title,
    },
  };
}

export default async function PullRequestPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const named = await params;
  const ref = refOf(named);
  if (!ref) {
    notFound();
  }
  const answer = await loadPullRequest(ref.url);
  return (
    <Shell
      address={{ number: String(ref.number), repo: `${ref.owner}/${ref.repo}` }}
      error={answer.ok ? null : answer.error}
      pullRequest={answer.ok ? answer.pr : null}
    />
  );
}
