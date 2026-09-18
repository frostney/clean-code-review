'use client';

import Image from 'next/image';
import { useState } from 'react';

import { splitPullRequest } from '@/lib/address';

import { PullRequestBodyToggle } from './PullRequestBodyToggle';
import { useReviewView } from './ReviewProvider';

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

/**
 * The owner's avatar, or nothing.
 *
 * GitHub may have sent none, and the one it sent may not load: a blocked
 * request, an offline reader, an account deleted since. The line it sits on
 * already names the owner, so a failure takes the image away rather than
 * leaving a broken frame in the header.
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
      src={src}
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
            className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-muted"
            data-pr-name={true}
          >
            <OwnerAvatar src={pr.avatarUrl} />
            <span className="truncate">
              {address.repo}#{address.number}
            </span>
          </p>
        ) : null}
        <p className="min-w-0 text-[13px]">
          {pr.url ? (
            <a
              className="inline-flex min-h-10 items-center font-semibold text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent lg:min-h-0"
              data-pr-title={true}
              href={pr.url}
              rel="noreferrer"
              target="_blank"
            >
              {pr.title}
            </a>
          ) : (
            <span className="font-semibold text-ink" data-pr-title={true}>
              {pr.title}
            </span>
          )}
        </p>
      </div>
      {hasBody ? (
        <PullRequestBodyToggle>{pr.body}</PullRequestBodyToggle>
      ) : null}
    </>
  );
}
