import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  type PullRequestRef,
  parsePullRequest,
} from '@/agent/lib/github/github';
import { pullRequestPath, pullRequestUrl } from '@/src/pull-request/address';
import {
  loadPullRequest,
  type PullRequestAnswer,
} from '@/src/pull-request/pull-request';
import { SITE } from '@/src/site/site';
import { Shell } from '@/src/ui/Shell';

interface Params {
  owner: string;
  repo: string;
  number: string;
}

// Route params are whatever was typed; the fetch's own parser folds case and
// turns non-GitHub spellings (`/pull/0002`, `/pull/abc`) into a 404.
function refOf(params: Params): PullRequestRef | null {
  return parsePullRequest(
    pullRequestUrl(`${params.owner}/${params.repo}`, params.number),
  );
}

function pathOf(ref: PullRequestRef): string {
  return `/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

/** Roughly what a search result shows. */
const DESCRIPTION_CHARS = 160;

const OPEN_GRAPH_IMAGE = '/opengraph-image';
const TWITTER_IMAGE = '/twitter-image';

// Markdown is left in: stripping it properly would mean parsing it.
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
 * `noindex`: this site is not to become a search index of other people's pull
 * requests. The canonical is GitHub's current name for the PR, which follows
 * renames, not the casing that was typed.
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
  // The answer carries the address GitHub redirected to, if any.
  const path =
    (answer.ok ? pullRequestPath(answer.pr.url) : null) ?? pathOf(ref);
  return {
    alternates: { canonical: path },
    description,
    openGraph: {
      description,
      // Named explicitly: a child's openGraph replaces the layout's whole
      // block, including the file-convention image.
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

/**
 * Fetched on the server so a shared link is a review in the first paint. A
 * failed fetch is the landing view with the reason, not a 500.
 */
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
