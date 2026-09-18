import type { ReactNode } from 'react';

import {
  dollars,
  PAGE_DAILY_BUDGET_USD,
  PAGE_HOURLY_BUDGET_USD,
} from '@/agent/lib/budgets';
import { QUESTION_COUNT, SMELL_IDS } from '@/agent/lib/questions';
import { REVIEW_LIMITS, SESSION_COST_CAP_USD } from '@/agent/lib/review';
import { REVIEWER_MODEL } from '@/agent/lib/summary';
import { SITE } from '@/lib/site';

/** The session cap, in the unit the answer says it in. */
const CENTS_PER_DOLLAR = 100;
const CAP_CENTS = SESSION_COST_CAP_USD * CENTS_PER_DOLLAR;

/** How many of the answers are scales rather than probabilities. */
const SCALE_COUNT = QUESTION_COUNT - SMELL_IDS.length;

/**
 * The questions people actually ask about this page, answered once and read
 * twice: by whoever opens `/faq`, and by whatever answer engine reads the
 * `FAQPage` structured data that route emits. The same array feeds both, so
 * the markup can never describe something the page does not say out loud.
 *
 * Every number here is read from the code it describes rather than typed
 * twice, and every claim is one that code makes.
 */
export const FAQ: readonly { q: string; a: string }[] = [
  {
    a: `Code, one file at a time, against ${QUESTION_COUNT} questions drawn from the chapters of Robert C. Martin's Clean Code: names, functions, comments, formatting, objects and data structures, error handling, unit tests, classes and the smells chapter. Of those answers, ${SMELL_IDS.length} are probabilities and ${SCALE_COUNT} are scores on a five-level scale, so the meters compare between files. Markdown and other prose files are shown beside the review and never judged.`,
    q: 'What does it judge?',
  },
  {
    a: `Two. Jev, TypeSafe's evaluation model, reached through the Vercel AI Gateway, answers the whole question set for one file in a single call and returns probabilities and scores, no prose. Luna (${REVIEWER_MODEL}) writes the words: each file's section from Jev's findings and that file's code, and the decision at the top from every file's findings and the pull request's title and description.`,
    q: 'Which models do the work?',
  },
  {
    a: 'No. Each browser tab is one eve session that holds the files only for the turn being judged, the page clears that history before every turn, and the session ends with the tab. There is no account and no database. An identical turn can come back from a one-hour cache, which is what the "from cache" note means.',
    q: 'Is my code stored?',
  },
  {
    a: `A pull request arrives as one unified diff and is split per file. The question set adjusts: a diff is also asked whether it leaves the code worse than it found it, and only a test file is asked whether its tests are clear. One turn judges at most ${REVIEW_LIMITS.maxFiles} code files, whichever changed most, and shows up to ${REVIEW_LIMITS.maxProseFiles} prose files beside them. Images, lockfiles and generated files are skipped, and only public repositories can be fetched.`,
    q: 'How is a pull request judged?',
  },
  {
    a: `Yes, and there is nothing to sign in to. Each browser tab carries its own cap of ${CAP_CENTS} cents of model time, so a single session cannot run up a bill; when a tab reaches the cap the meters keep their last answers and a reload starts a fresh session. The whole site shares a model budget of ${dollars(PAGE_HOURLY_BUDGET_USD)} an hour and ${dollars(PAGE_DAILY_BUDGET_USD)} a UTC day, and pauses new reviews until it resets once that is spent. The source is MIT-licensed, at ${SITE.source.replace(/^https?:\/\//, '')}.`,
    q: 'Is it free?',
  },
];

/**
 * Phrases in the answers that are links on the page and plain words in the
 * structured data. They live apart from the text because `FAQ` has to stay a
 * list of strings: a `FAQPage` answer is quoted, not rendered, and an anchor
 * inside it would reach an answer engine as markup.
 */
const LINKS: readonly { href: string; text: string }[] = [
  {
    href: SITE.author,
    text: 'Robert C. Martin',
  },
  {
    href: SITE.book,
    text: 'Clean Code',
  },
  { href: SITE.jev, text: "Jev, TypeSafe's evaluation model" },
];

/** The phrases above as one alternation, captured so `split` keeps them. */
const LINK_PATTERN = new RegExp(
  `(${LINKS.map((link) => link.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
);

/** The accent link, spelled the way the rest of the page spells one. */
const LINK_CLASS =
  'text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent';

/**
 * One answer as it is read rather than as it is stored: the two phrases above
 * become links, and every other run of text stays exactly the string the
 * structured data carries.
 */
function answerNodes(answer: string): ReactNode[] {
  return answer.split(LINK_PATTERN).map((part) => {
    const link = LINKS.find((item) => item.text === part);
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
