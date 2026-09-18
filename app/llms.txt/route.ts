import { QUESTION_COUNT } from '@/agent/lib/questions';
import { SITE } from '@/lib/site';

/**
 * What this page is, for a model that has been asked about it and cannot click
 * anything. One paragraph and the four links worth following — the same claims
 * the page makes on screen, in the plainest form they can be made in.
 */
const LLMS_TXT = `# ${SITE.name}

> ${SITE.tagline}

${SITE.name} judges code against the chapters of Robert C. Martin's *Clean Code*. Point it at a public GitHub pull request, or paste a unified diff or a file, and Jev — TypeSafe's evaluation model, reached through the Vercel AI Gateway — answers ${QUESTION_COUNT} questions about every code file in the change in a single turn: names, functions, comments, formatting, objects, error handling, tests, classes and smells. Every answer is a probability or a score rather than prose, so the verdict is made of things a reader can check. Luna then writes the review: each file's section from Jev's findings and that file's code, the overall decision from the findings for every file and the pull request's description. Markdown and other prose files in a change are shown with the review and never judged. Every example on the page is editable, and an edit re-judges only the file that changed. The code is held in the browser tab's own eve session for the turn it is judged in and is not stored afterwards; there is no account and nothing to sign in to.

## Links

- [${SITE.name}](${SITE.url}): the app itself — paste a pull request, a diff or a file.
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
