import Link from 'next/link';

import { SITE } from '@/lib/site';

/** The footer's one shape, worn by four links. */
const LINK_CLASS =
  'inline-flex min-h-10 items-center underline hover:text-ink lg:min-h-0';

/**
 * Who did the work, where it came from, and where the questions about it are
 * answered. Everything here is the same on every visit, so the whole line is
 * rendered on the server and none of it reaches the browser as JavaScript.
 *
 * The first link is the way to `/faq`, phrased as the question someone would
 * actually be asking at the bottom of a page they have not used yet. It is
 * first because it is the only one of the four that stays on this site.
 */
export function Footer() {
  return (
    <footer className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
      <Link className={LINK_CLASS} href="/faq">
        how does this work?
      </Link>
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
      <span className="ml-auto" />
    </footer>
  );
}
