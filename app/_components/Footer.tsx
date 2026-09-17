import { SITE } from "@/lib/site";
import { TokenCount } from "./TokenCount";

/**
 * Who did the work and where it came from. Everything here is the same on
 * every visit except the token count, which is the one island in the line.
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
    </footer>
  );
}
