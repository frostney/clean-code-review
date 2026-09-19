import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { DuckTransition } from '@/src/landing/DuckTransition';
import { SITE } from '@/src/site/site';

/** The duck, small: the mark at the top of a page with no wordmark, and the way back. */
const DUCK_PX = 40;

/**
 * The top of every page of prose (the questions, the privacy notes): the
 * duck as the way home, the page's title, and one line of what it is for.
 * One shape for all of them, so leaving the tool for a page of text always
 * looks like the same step.
 */
export function PageHeader({
  title,
  children,
}: {
  title: string;
  /** The lede, in the page's body size. */
  children: ReactNode;
}) {
  return (
    <header className="mb-6">
      {/* The landing page's duck, arriving: a link here from `/`, or this one
          back to it, morphs one bird into the other. */}
      <DuckTransition>
        <Link
          aria-label={`Back to ${SITE.name}`}
          className="inline-flex rounded-md"
          href="/"
        >
          <Image
            alt=""
            height={DUCK_PX}
            priority={true}
            src="/ducky-64.png"
            width={DUCK_PX}
          />
        </Link>
      </DuckTransition>
      <h1 className="mt-3 text-xl font-semibold tracking-tight text-ink">
        {title}
      </h1>
      <div className="mt-1.5 max-w-[70ch] text-sm leading-relaxed text-ink">
        {children}
      </div>
    </header>
  );
}
