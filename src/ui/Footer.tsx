import Link from 'next/link';

import { SITE } from '@/src/site/site';

/** The footer's one shape, worn by every link. */
const LINK_SHAPE = 'inline-flex min-h-10 items-center lg:min-h-0';
const LINK_CLASS = `${LINK_SHAPE} underline hover:text-ink`;
/** The page the reader is on: in ink and not underlined, so it reads as "here". */
const CURRENT_CLASS = `${LINK_SHAPE} text-ink`;

/**
 * Who did the work, where it came from, and where the questions about it are
 * answered. Everything here is the same on every visit, so the whole line is
 * rendered on the server and none of it reaches the browser as JavaScript.
 *
 * The first link is the way to `/faq`, phrased as the question someone would
 * actually be asking at the bottom of a page they have not used yet, and the
 * second is what happens to the code. They come first because they are the
 * two that stay on this site. `current` marks the page the reader is on, which
 * stays a link but says so, and loses its underline so it reads as "here".
 */
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
