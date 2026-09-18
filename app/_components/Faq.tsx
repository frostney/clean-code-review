import type { ReactNode } from 'react';

import { FAQ, FAQ_LINK_PATTERN, FAQ_LINKS } from '@/lib/faq';

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
 * The questions, open. They were folds on the landing page, where they were a
 * footnote to a field; on a page of their own there is nothing to fold them
 * out of the way of, and structured data that answers something the page keeps
 * shut is a lie to a machine.
 */
export function Faq() {
  return (
    <div className="flex max-w-[70ch] flex-col gap-2">
      {FAQ.map((item) => (
        <section
          className="rounded-md border border-line bg-surface px-3 py-2.5"
          data-faq={true}
          key={item.q}
        >
          <h2 className="text-[13px] font-semibold text-ink">{item.q}</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
            {answerNodes(item.a)}
          </p>
        </section>
      ))}
    </div>
  );
}
