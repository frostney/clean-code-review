'use client';

import Image from 'next/image';
import { useState } from 'react';

import { useReviewView } from '@/src/review/ReviewProvider';

import { splitPullRequest } from './address';
import { PullRequestBodyToggle } from './PullRequestBodyToggle';

/**
 * What is being reviewed, when it came from a pull request: whose project it
 * is and which request it is, the title linked back to GitHub under that, and
 * the author's description under all of it. The description is the node the
 * server action rendered — this only decides whether it is on screen and
 * folds it.
 *
 * A title says what a change does and never which repository it happened in,
 * which is the one thing a reader who arrived by link cannot work out. The
 * line above it says that in the spelling GitHub itself uses, and the avatar
 * beside it is what makes a familiar project recognisable before the words
 * are read.
 */

/** The avatar, in CSS pixels: the cap height of the line it sits on. */
const AVATAR_PX = 20;

/** Twice the drawn size, for a screen with twice the pixels. */
const AVATAR_REQUEST_PX = AVATAR_PX * 2;

/** GitHub sizes an avatar itself when asked: `?s=40` on a URL that already has a query. */
function sized(src: string): string {
  return `${src}${src.includes('?') ? '&' : '?'}s=${AVATAR_REQUEST_PX}`;
}

/**
 * The owner's avatar, or nothing.
 *
 * GitHub may have sent none, and the one it sent may not load: a blocked
 * request, an offline reader, an account deleted since. The line it sits on
 * already names the owner, so a failure takes the image away rather than
 * leaving a broken frame in the header. One project's avatar failing says
 * nothing about the next one's, so the caller keys this on the address and a
 * new project starts with a fresh attempt.
 *
 * `unoptimized`, and GitHub asked for the size instead. Routing it through
 * Next's optimiser would mean allowing that host in `next.config.ts`, and
 * `/_next/image` answers anyone: an allowed host with no path is a public
 * image proxy, billed per transformation, on a site whose whole design is a
 * spending cap. GitHub resizes its own avatars for free.
 */
function OwnerAvatar({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return null;
  }

  return (
    <Image
      alt=""
      className="shrink-0 rounded-md border border-line"
      data-pr-avatar={true}
      height={AVATAR_PX}
      onError={() => setBroken(true)}
      src={sized(src)}
      unoptimized={true}
      width={AVATAR_PX}
    />
  );
}

export function PullRequestSummary() {
  const { review } = useReviewView();
  const pr = review.pr;
  if (!pr) {
    return null;
  }
  // `ReactNode` includes a promise, which is not something to test for
  // truthiness; the description is either a node the server rendered or not one.
  const hasBody = pr.body !== undefined && pr.body !== null;
  const address = splitPullRequest(pr.url);

  return (
    <>
      <div className="mt-3 min-w-0">
        {address ? (
          <p
            className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted"
            data-pr-name={true}
          >
            <OwnerAvatar key={pr.avatarUrl} src={pr.avatarUrl} />
            <span className="truncate">
              {address.repo}#{address.number}
            </span>
          </p>
        ) : null}
        {/* The title is the page's heading once a review is open: larger than
            anything the author's description can set, and in ink, so it reads
            as the review's subject rather than as one more link. It is still
            the way to the pull request on GitHub, which hover and focus say. */}
        <h2 className="min-w-0 text-lg leading-snug font-semibold text-ink">
          {pr.url ? (
            <a
              className="inline-flex min-h-10 items-center decoration-accent underline-offset-4 hover:text-accent hover:underline lg:min-h-0"
              data-pr-title={true}
              href={pr.url}
              rel="noreferrer"
              target="_blank"
            >
              {pr.title}
            </a>
          ) : (
            <span data-pr-title={true}>{pr.title}</span>
          )}
        </h2>
      </div>
      {hasBody ? (
        <PullRequestBodyToggle>{pr.body}</PullRequestBodyToggle>
      ) : null}
    </>
  );
}
