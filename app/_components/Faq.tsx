import { QUESTION_COUNT } from '@/agent/lib/questions';
import { REVIEW_LIMITS } from '@/agent/lib/review';

/**
 * The questions people actually ask about this page, answered once and read
 * twice: by whoever opens one of the folds, and by whatever answer engine
 * reads the `FAQPage` structured data in `page.tsx`. The same array feeds both,
 * so the markup can never describe something the page does not say out loud.
 */
export const FAQ: readonly { q: string; a: string }[] = [
  {
    a: `Every code file in the change, one at a time, against ${QUESTION_COUNT} questions drawn from the chapters of Robert C. Martin's Clean Code: names, functions, comments, formatting, objects and data structures, error handling, tests, classes and the smells chapter. Each answer is a probability, a score or a choice rather than a sentence, which is what makes the meters comparable across files.`,
    q: 'What does it judge?',
  },
  {
    a: "Jev, TypeSafe's evaluation model, reached through the Vercel AI Gateway. It answers the whole question set for a file in a single call rather than writing prose about it. The review you read is written separately by Luna from Jev's findings — the reviewer never sees the code, which is why it names smells rather than lines.",
    q: 'Which model does the judging?',
  },
  {
    a: 'No. Each browser tab is one eve session that holds the files only for the turn being judged, and the page clears that history before every turn; the session is dropped when the tab closes. There is no account and no database. Identical turns may come back from a one-hour cache, which is what the “from cache” note means.',
    q: 'Is my code stored?',
  },
  {
    a: `A pull request arrives as a unified diff and is split per file, with each file's hunks kept under the headers git wrote. The questions change to suit: a diff is also asked whether it leaves the code cleaner than it found it, and a file with no test is not asked how good its tests are. At most ${REVIEW_LIMITS.maxFiles} files are judged in one turn, largest first, and images, binaries and generated files never become a card.`,
    q: 'How are pull requests and diffs judged?',
  },
  {
    a: 'Because a verdict is only worth what it is made of. One question per idea in the book keeps every answer small enough to check against the code in front of you, and the questions that do not apply to a file are not asked at all — a row nobody answered would read as a clean bill of health.',
    q: `Why ${QUESTION_COUNT} questions?`,
  },
  {
    a: 'Yes, and there is nothing to sign in to. Each tab carries a small spending cap so that one session cannot run up a bill; when it is reached the meters freeze on the last answers and a reload starts a fresh session. The whole thing is open source.',
    q: 'Is it free?',
  },
];

/**
 * The same questions on the page, folded shut. Structured data that answers
 * something the page does not is a lie to a machine, so this is rendered on
 * the server, as real text, above the footer.
 */
export function Faq() {
  return (
    <section
      aria-labelledby="faq-heading"
      className="mt-8 border-t border-line pt-4"
    >
      <h2
        className="mb-2 text-tiny font-semibold tracking-wider text-muted uppercase"
        id="faq-heading"
      >
        Questions about this page
      </h2>
      <div className="flex max-w-[80ch] flex-col gap-1.5">
        {FAQ.map((item) => (
          <details
            className="rounded-md border border-line bg-surface px-3 py-1.5 lg:py-2"
            data-faq={true}
            key={item.q}
          >
            <summary className="cursor-pointer py-1.5 text-[13px] font-semibold text-ink marker:text-muted lg:py-0">
              {item.q}
            </summary>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              {item.a}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
