import { SITE } from "@/lib/site";
import { ThemeToggle } from "./ThemeToggle";
import { TokenCount } from "./TokenCount";

/**
 * Who did the work and where it came from, and — at the far right — which
 * paper the page is on. Everything here is the same on every visit except the
 * token count and the theme button, which are the two islands in the line.
 *
 * The theme control lives down here rather than beside the address field: it
 * is set once and never again, and the top of this page is one field wide on a
 * phone with nothing to spare.
 */
export function Footer() {
  return (
    <footer className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
      <TokenCount />
      <a href={SITE.jev} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center underline hover:text-ink lg:min-h-0">
        judged by Jev
      </a>
      <a href={SITE.eve} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center underline hover:text-ink lg:min-h-0">
        built with eve
      </a>
      <a href={SITE.source} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center underline hover:text-ink lg:min-h-0">
        view source
      </a>
      <span className="ml-auto">
        <ThemeToggle />
      </span>
    </footer>
  );
}
