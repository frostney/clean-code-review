import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { FAQ, FAQ_LINK_PATTERN, FAQ_LINKS } from '@/src/site/faq';

/** The accent link, spelled the way the rest of the page spells one. */
const LINK_CLASS =
  'text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent';

/**
 * One answer as it is read rather than as it is stored: the phrases in
 * `FAQ_LINKS` become links, and every other run of text stays exactly the string the
 * structured data carries.
 */
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
 * The questions, folded: one line each, so the page reads as a list of what
 * can be asked, and each opens where it stands.
 *
 * A native `<details>` does the folding, which works without a line of
 * script: Enter and Space open it, and the state it announces is the
 * browser's own. A closed answer is still in the document, so the
 * server-rendered HTML carries every answer the page's `FAQPage` structured
 * data claims, and the browser's find-in-page opens the one it lands in.
 *
 * The question's heading is inside the summary so that the whole line is the
 * control. Checked in Chrome's accessibility tree on 2026-09-18: each question
 * is still a heading, inside its disclosure control, so moving by heading
 * finds every one. Safari with VoiceOver was not tested; some screen readers
 * are said to flatten a summary's contents. The chevron turns to say which way it will go, and is hidden from
 * a screen reader, which hears expanded or collapsed instead.
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
