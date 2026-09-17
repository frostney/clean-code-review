import { QUESTION_COUNT } from "@/agent/lib/questions";

/**
 * Who this page says it is, in one place. The metadata, the Open Graph image,
 * robots.txt, the sitemap, llms.txt and the footer all describe the same
 * product, so they read from the same few strings rather than four copies that
 * drift apart.
 */
export const SITE = {
  name: "Clean Code Review",
  /** The canonical origin. A fork deploying elsewhere sets this. */
  url: process.env.NEXT_PUBLIC_SITE_URL || "https://clean-code-review.vercel.app",
  /** Where this page's own source lives. A deploy elsewhere can point it away. */
  source: process.env.NEXT_PUBLIC_SOURCE_URL || "https://github.com/frostney/clean-code-review",
  /** One line, for the Open Graph image and the first paragraph of llms.txt. */
  tagline: `${QUESTION_COUNT} Clean Code questions, asked of every file in a pull request.`,
  /** ~150 characters: what a search result or a chat answer quotes. */
  description: `Paste a GitHub pull request, a diff or a codebase. Jev, TypeSafe’s evaluation model, answers ${QUESTION_COUNT} Clean Code questions per file and Luna writes the review.`,
  /** Jev on the AI Gateway, and the framework the agent runs on. */
  jev: "https://vercel.com/ai-gateway/models/jev",
  eve: "https://eve.dev",
} as const;
