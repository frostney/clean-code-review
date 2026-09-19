import { QUESTION_COUNT, SMELL_IDS } from '@/agent/lib/judging/questions';
import { REVIEW_LIMITS, SESSION_COST_CAP_USD } from '@/agent/lib/review/review';
import { REVIEWER_MODEL } from '@/agent/lib/review/summary';
import {
  dollars,
  MCP_DAILY_BUDGET_USD,
  MCP_HOURLY_BUDGET_USD,
  PAGE_DAILY_BUDGET_USD,
  PAGE_HOURLY_BUDGET_USD,
} from '@/agent/lib/spend/budgets';
import {
  MCP_CALLS_PER_WINDOW,
  MCP_PATH,
  MCP_SERVER_CARD_PATH,
  MCP_WINDOW_MINUTES,
} from '@/src/mcp/mcp-limits';

import { SITE } from './site';

const CENTS_PER_DOLLAR = 100;
const CAP_CENTS = SESSION_COST_CAP_USD * CENTS_PER_DOLLAR;

const SCALE_COUNT = QUESTION_COUNT - SMELL_IDS.length;

/**
 * The single source for `/faq`, its `FAQPage` JSON-LD and the agent Markdown.
 * React-free because `proxy.ts` bundles it. Every number is imported.
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
    a: `Yes, over MCP, at ${SITE.url}${MCP_PATH}. It has two tools: one reviews a public GitHub pull request, the other reviews pasted code or a diff, and both return every answer, the written review and what the call cost. Each address can make ${MCP_CALLS_PER_WINDOW} calls every ${MCP_WINDOW_MINUTES} minutes, and all callers share ${dollars(MCP_HOURLY_BUDGET_USD)} an hour and ${dollars(MCP_DAILY_BUDGET_USD)} a UTC day of model time. A server card at ${SITE.url}${MCP_SERVER_CARD_PATH} describes it for clients that look one up.`,
    q: 'Can an agent use it?',
  },
  {
    a: `Yes, and there is nothing to sign in to. Each browser tab carries its own cap of ${CAP_CENTS} cents of model time, so a single session cannot run up a bill; when a tab reaches the cap the meters keep their last answers and a reload starts a fresh session. The whole site shares a model budget of ${dollars(PAGE_HOURLY_BUDGET_USD)} an hour and ${dollars(PAGE_DAILY_BUDGET_USD)} a UTC day, and pauses new reviews until it resets once that is spent. The source is MIT-licensed, at ${SITE.source.replace(/^https?:\/\//, '')}.`,
    q: 'Is it free?',
  },
];

// Kept apart so `FAQ` stays plain strings: JSON-LD answers are quoted, and an
// anchor would reach an answer engine as markup.
export const FAQ_LINKS: readonly { href: string; text: string }[] = [
  { href: SITE.author, text: 'Robert C. Martin' },
  { href: SITE.book, text: 'Clean Code' },
  { href: SITE.jev, text: "Jev, TypeSafe's evaluation model" },
];

/** Captured so `split` keeps the phrases. */
export const FAQ_LINK_PATTERN = new RegExp(
  `(${FAQ_LINKS.map((link) => link.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
);

export function answerMarkdown(answer: string): string {
  return answer
    .split(FAQ_LINK_PATTERN)
    .map((part) => {
      const link = FAQ_LINKS.find((item) => item.text === part);
      return link ? `[${part}](${link.href})` : part;
    })
    .join('');
}
