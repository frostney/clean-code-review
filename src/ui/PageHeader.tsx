import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { DuckTransition } from '@/src/landing/DuckTransition';
import { SITE } from '@/src/site/site';

const DUCK_PX = 40;

export function PageHeader({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <header className="mb-6">
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
      <h1 className="mt-3 text-xl font-semibold tracking-tight text-ink">
        {title}
      </h1>
      <div className="mt-1.5 max-w-[70ch] text-sm leading-relaxed text-ink">
        {children}
      </div>
    </header>
  );
}
