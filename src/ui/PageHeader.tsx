import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { DuckTransition } from '@/src/landing/DuckTransition';
import { SITE } from '@/src/site/site';

import { PAGE_HEADER, PAGE_TITLE } from './view-transition-names';

const DUCK_PX = 40;

export function PageHeader({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    /* Named so the block travels to its new place between pages instead of
       dissolving into them; the duck inside carries its own name and moves
       separately. */
    <header className="mb-6" style={PAGE_HEADER}>
      {/* Morphs into the landing duck when navigating to and from `/`. */}
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
      <h1
        className="mt-3 text-xl font-semibold tracking-tight text-ink"
        style={PAGE_TITLE}
      >
        {title}
      </h1>
      <div className="mt-1.5 max-w-[70ch] text-sm leading-relaxed text-ink">
        {children}
      </div>
    </header>
  );
}
