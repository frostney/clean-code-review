import Link from 'next/link';

import { SITE } from '@/src/site/site';

const LINK_SHAPE = 'inline-flex min-h-10 items-center lg:min-h-0';
const LINK_CLASS = `${LINK_SHAPE} underline hover:text-ink`;
const CURRENT_CLASS = `${LINK_SHAPE} text-ink`;

// On-site links first; the current page stays a link with `aria-current`.
export function Footer({ current }: { current?: 'faq' | 'privacy' }) {
  const here = (page: 'faq' | 'privacy') =>
    current === page
      ? {
          'aria-current': 'page' as const,
          className: CURRENT_CLASS,
        }
      : { className: LINK_CLASS };

  return (
    <footer className="mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted">
      <Link {...here('faq')} href="/faq">
        how does this work?
      </Link>
      <Link {...here('privacy')} href="/privacy">
        privacy
      </Link>
      <a
        className={LINK_CLASS}
        href={SITE.book}
        rel="noreferrer"
        target="_blank"
      >
        based on Clean Code
      </a>
      <a
        className={LINK_CLASS}
        href={SITE.jev}
        rel="noreferrer"
        target="_blank"
      >
        judged by Jev
      </a>
      <a
        className={LINK_CLASS}
        href={SITE.eve}
        rel="noreferrer"
        target="_blank"
      >
        built with eve
      </a>
      <a
        className={LINK_CLASS}
        href={SITE.source}
        rel="noreferrer"
        target="_blank"
      >
        view source
      </a>
    </footer>
  );
}
