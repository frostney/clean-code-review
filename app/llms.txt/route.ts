import {
  dollars,
  MCP_DAILY_BUDGET_USD,
  MCP_HOURLY_BUDGET_USD,
} from '@/agent/lib/budgets';
import { QUESTION_COUNT } from '@/agent/lib/questions';
import { REVIEW_LIMITS } from '@/agent/lib/review';
import {
  MAX_PASTE_CHARS,
  MCP_CALLS_PER_WINDOW,
  MCP_PATH,
  MCP_SERVER_CARD_PATH,
  MCP_TOOLS,
  MCP_WINDOW_MINUTES,
} from '@/lib/mcp-limits';
import { SITE } from '@/lib/site';

/**
 * What this page is, for a model that has been asked about it and cannot click
 * anything: one paragraph, the jobs it is the right tool for, and the links
 * worth following. The same claims the page makes on screen, in the plainest
 * form they can be made in.
 */
const LLMS_TXT = `# ${SITE.name}

> ${SITE.tagline}

${SITE.name} judges code against the chapters of Robert C. Martin's *Clean Code*. Point it at a public GitHub pull request, or paste a unified diff or a file, and Jev, TypeSafe's evaluation model reached through the Vercel AI Gateway, answers ${QUESTION_COUNT} questions about every code file in the change in a single turn: names, functions, comments, formatting, objects, error handling, tests, classes and smells. Every answer is a probability or a score rather than prose, so the verdict is made of things a reader can check. Luna then writes the review: each file's section from Jev's findings and that file's code, the overall decision from the findings for every file and the pull request's description. Markdown and other prose files in a change are shown with the review and never judged. Every example on the page is editable, and an edit re-judges only the file that changed. The code is held in the browser tab's own eve session for the turn it is judged in and is not stored afterwards; there is no account and nothing to sign in to.

## When to use this

Reach for ${SITE.name} when there is a public GitHub pull request, a unified diff or a single file, and the question is how well the code is written rather than whether it runs. It answers three jobs well: deciding whether a change is ready to merge, finding which files in a change carry the most smells, and comparing two ways of writing the same function by editing the code on the page and watching the answers move.

It is not a linter, a type checker, a test runner or a security scanner, and it never executes the code it reads. It judges at most ${REVIEW_LIMITS.maxFiles} code files in one review, ${REVIEW_LIMITS.maxCharsPerFile.toLocaleString('en-US')} characters each, from public repositories only.

An agent can open a review directly at ${SITE.url}/owner/repo/pull/123, and can read any page of this site as Markdown by sending the header \`Accept: text/markdown\`.

## MCP server

An agent without a browser gets the same review from the MCP server at ${SITE.url}${MCP_PATH}, over stateless Streamable HTTP with no sign-in. It has two tools, and each returns every answer Jev gave per file, Luna's decision and paragraphs, the files that were not judged and why, the models and the cost, as structured content and as text.

- \`${MCP_TOOLS.pullRequest}\` takes a public GitHub pull request URL and also returns the permalink to the same review on this site.
- \`${MCP_TOOLS.paste}\` takes what you would paste into the page: a unified diff, whole files each introduced by a \`// file: path\` line, or a single file, up to ${MAX_PASTE_CHARS.toLocaleString('en-US')} characters.

Each address may make ${MCP_CALLS_PER_WINDOW} calls per ${MCP_WINDOW_MINUTES} minutes. Every caller shares one model budget of ${dollars(MCP_HOURLY_BUDGET_USD)} per hour and ${dollars(MCP_DAILY_BUDGET_USD)} per UTC day. Once it is spent, the endpoint refuses new reviews and says when the budget resets; a review answered wholly from the cache is still served.

A server card describing it is at ${SITE.url}${MCP_SERVER_CARD_PATH}, and the site's AI Catalog at ${SITE.url}/.well-known/ai-catalog.json lists it. Both follow the server card proposal, which is not yet part of the MCP specification.

## Links

- [${SITE.name}](${SITE.url}): the app itself. Paste a pull request, a diff or a file.
- [Questions about it](${SITE.url}/faq): what it judges, which models do the work, and the limits.
- [Privacy](${SITE.url}/privacy): what leaves the browser and how long anything is kept.
- [Source](${SITE.source}): the whole thing, including the question set and the prompts.
- [Jev on the Vercel AI Gateway](${SITE.jev}): the evaluation model that answers the questions.
- [eve](${SITE.eve}): the agent framework the judging turn runs on.
`;

export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(LLMS_TXT, {
    headers: {
      'cache-control': 'public, max-age=3600',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}
