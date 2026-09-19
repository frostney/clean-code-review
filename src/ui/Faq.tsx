import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { FAQ, FAQ_LINK_PATTERN, FAQ_LINKS } from '@/src/site/faq';

const LINK_CLASS =
  'text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent';

// Non-link text stays byte-identical to the JSON-LD answer.
function answerNodes(answer: string): ReactNode[] {
  return answer.split(FAQ_LINK_PATTERN).map((part) => {
    const link = FAQ_LINKS.find((item) => item.text === part);
    if (!link) {
      return part;
    }
    return (
      <a
        className={LINK_CLASS}
        href={link.href}
        key={part}
        rel="noreferrer"
        target="_blank"
      >
        {part}
      </a>
    );
  });
}

/**
 * Native `<details>`: no script, and closed answers stay in the HTML for the
 * JSON-LD and find-in-page. Headings sit inside `<summary>` so the whole line
 * is the control; still headings in Chrome's a11y tree (checked 2026-09-18),
 * VoiceOver untested.
 */
export function Faq() {
  return (
    <div className="flex max-w-[70ch] flex-col gap-2">
      {FAQ.map((item) => (
        <details
          className="group rounded-md border border-line bg-surface"
          data-faq={true}
          key={item.q}
        >
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2.5 hover:text-ink [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden="true"
              className="shrink-0 text-muted motion-safe:transition-transform motion-safe:duration-150 group-open:rotate-90"
              size={14}
            />
            <h2 className="text-sm font-semibold text-ink">{item.q}</h2>
          </summary>
          <p className="-mt-1 px-3 pb-2.5 pl-[2.125rem] text-sm leading-relaxed text-muted">
            {answerNodes(item.a)}
          </p>
        </details>
      ))}
    </div>
  );
}
