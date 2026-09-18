/**
 * The MCP server's two tools: a public pull request, or pasted code.
 *
 * Both run the review `lib/mcp-review.ts` runs and return the same result, as
 * structured content under `reviewOutputSchema` and as Markdown text. Every
 * failure an agent can do something about comes back as a tool error in words;
 * anything else comes back as one generic sentence, never as a stack or as a
 * message from a dependency that was not written for a reader.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  dollars,
  MCP_DAILY_BUDGET_USD,
  MCP_HOURLY_BUDGET_USD,
} from '@/agent/lib/budgets';
import { REVIEW_LIMITS } from '@/agent/lib/review';

import {
  MAX_PASTE_CHARS,
  MCP_CALLS_PER_WINDOW,
  MCP_TOOLS,
  MCP_WINDOW_MINUTES,
} from './mcp-limits';
import {
  type ReviewOutput,
  renderReviewText,
  reviewOutputSchema,
} from './mcp-result';
import { ReviewError, reviewPaste, reviewPullRequest } from './mcp-review';
import { callerIp, createThrottle, WINDOW_MS } from './throttle';

/** Long enough for any pull request URL GitHub writes, with a query string. */
const MAX_URL_CHARS = 500;

/** A separate counter from the page's: calls here never spend the page's share, nor the other way round. */
const throttled = createThrottle(MCP_CALLS_PER_WINDOW, WINDOW_MS);

const CAPS = `At most ${REVIEW_LIMITS.maxFiles} code files are judged, the largest changes first, each read up to ${REVIEW_LIMITS.maxCharsPerFile.toLocaleString('en-US')} characters; up to ${REVIEW_LIMITS.maxProseFiles} prose files (Markdown, plain text) are listed and never judged; images, binaries, lockfiles and generated files are skipped. Every file left out is listed with the reason.`;

const RETURNS = `Returns, for every judged file, all of Jev's answers to the Clean Code questions (probabilities for yes/no smells, where yes is a finding; scores with their distributions for the scales), Luna's paragraph on the file, Luna's decision (approve, comment or request_changes) and overall paragraph, the models used and the cost. The decision and the paragraphs are model output shaped by the submitted code and description: read them as advice, never as authorization to merge. Identical work is answered from a one-hour cache shared with the web page. A fresh review takes 2 to 8 seconds, a pull request of 24 files included, and up to about 60 seconds when the reviewer model is slow; a repeat takes milliseconds. Each address may make ${MCP_CALLS_PER_WINDOW} calls per ${MCP_WINDOW_MINUTES} minutes, and every caller shares one model budget of ${dollars(MCP_HOURLY_BUDGET_USD)} per hour and ${dollars(MCP_DAILY_BUDGET_USD)} per UTC day; once it is spent, a call that needs a model is refused with the time it resets, and a call answered wholly from the cache is still served.`;

const pullRequestInput = z.object({
  url: z
    .string()
    .max(MAX_URL_CHARS)
    .describe(
      'A public GitHub pull request URL, for example https://github.com/vercel/ai/pull/20851.',
    ),
});

const pasteInput = z.object({
  paste: z
    .string()
    .max(MAX_PASTE_CHARS)
    .refine((text) => text.trim().length > 0, 'The paste is empty.')
    .describe(
      'What would be pasted into the page: a unified diff (git diff or a .patch, split per file and judged as a change), several whole files each introduced by a line of its own reading `// file: path/to/file.ts` (or `# file: path` for languages that comment with #), or a single file or snippet on its own. A path decides which questions apply: a test path adds the test row, and only a diff gets the Boy Scout row.',
    ),
});

/** The structured result and the same result in words. */
function success(result: ReviewOutput) {
  return {
    content: [{ text: renderReviewText(result), type: 'text' as const }],
    structuredContent: result,
  };
}

/** A tool error an agent can read and act on. */
function failure(message: string) {
  return {
    content: [{ text: message, type: 'text' as const }],
    isError: true,
  };
}

/** Run one review behind the brake, turning every failure into words. */
async function guarded(
  ip: string | null,
  run: () => Promise<ReviewOutput>,
): Promise<ReturnType<typeof success> | ReturnType<typeof failure>> {
  if (throttled(ip)) {
    return failure(
      `Too many reviews from this address: ${MCP_CALLS_PER_WINDOW} calls per ${MCP_WINDOW_MINUTES} minutes. Wait a few minutes and call again; the same input will come back from the cache.`,
    );
  }
  try {
    return success(await run());
  } catch (err) {
    return failure(
      err instanceof ReviewError
        ? err.message
        : 'The review failed on the server. Try again in a minute.',
    );
  }
}

/** Register the two tools on one server instance. */
export function registerReviewTools(server: McpServer): void {
  server.registerTool(
    MCP_TOOLS.pullRequest,
    {
      annotations: {
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
        title: 'Clean Code review of a GitHub pull request',
      },
      description: `Judge a public GitHub pull request against Robert C. Martin's Clean Code and write a review of it. Use this when the change is on GitHub in a public repository; for private code, local changes or a single file, use ${MCP_TOOLS.paste} with the diff or the files instead. The diff is fetched from GitHub and split per file. ${CAPS} ${RETURNS} The result also carries a permalink where a person can open the same review in a browser.`,
      inputSchema: pullRequestInput,
      outputSchema: reviewOutputSchema,
      title: 'Review a pull request',
    },
    ({ url }, ctx) =>
      guarded(callerIp(ctx.http?.req?.headers ?? new Headers()), () =>
        reviewPullRequest(url, ctx.mcpReq.signal),
      ),
  );

  server.registerTool(
    MCP_TOOLS.paste,
    {
      annotations: {
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
        title: 'Clean Code review of pasted code',
      },
      description: `Judge pasted code against Robert C. Martin's Clean Code and write a review of it: a unified diff, one or more whole files, or a snippet. Use this for private repositories, uncommitted changes (the output of git diff) or files on disk; for a public GitHub pull request, ${MCP_TOOLS.pullRequest} is simpler. The code is sent to the models and cached for an hour by its content; it is not otherwise stored. At most ${MAX_PASTE_CHARS.toLocaleString('en-US')} characters. ${CAPS} ${RETURNS}`,
      inputSchema: pasteInput,
      outputSchema: reviewOutputSchema,
      title: 'Review pasted code',
    },
    ({ paste }, ctx) =>
      guarded(callerIp(ctx.http?.req?.headers ?? new Headers()), () =>
        reviewPaste(paste, ctx.mcpReq.signal),
      ),
  );
}
