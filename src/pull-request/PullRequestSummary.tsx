'use client';

import Image from 'next/image';
import { useState } from 'react';

import { useReviewView } from '@/src/review/ReviewProvider';

import { splitPullRequest } from './address';
import { PullRequestBodyToggle } from './PullRequestBodyToggle';

// The owner/repo line exists because a title never says which repository a
// change is in, which a reader arriving by link cannot otherwise tell.

const AVATAR_PX = 20;

/** 2x for high-density screens. */
const AVATAR_REQUEST_PX = AVATAR_PX * 2;

/** GitHub resizes its own avatars via `s=`. */
function sized(src: string): string {
  return `${src}${src.includes('?') ? '&' : '?'}s=${AVATAR_REQUEST_PX}`;
}

/**
 * A failed load removes the image (the line already names the owner); keyed on
 * the URL so the next project gets a fresh attempt. `unoptimized`: allowing
 * GitHub in `next.config.ts` would make `/_next/image` a public billed proxy.
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
  // Not a truthiness test: `ReactNode` includes a promise.
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
        {/* Larger than any heading the description can set, and in ink rather
            than link colour, so it reads as the subject. */}
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
