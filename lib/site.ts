/**
 * Who this page says it is, in one place. The metadata, the Open Graph image,
 * robots.txt, the sitemap, llms.txt and the footer all describe the same
 * product, so they read from the same few strings rather than four copies that
 * drift apart.
 */
export const SITE = {
  /** ~150 characters: what a search result or a chat answer quotes. */
  description:
    "Paste a GitHub pull request, a diff or a codebase. Jev, TypeSafe's evaluation model, judges every code file against Clean Code and Luna writes the review.",
  eve: 'https://eve.dev',
  /** Jev on the AI Gateway, and the framework the agent runs on. */
  jev: 'https://vercel.com/ai-gateway/models/jev',
  name: 'Clean Code Review',
  /** Where this page's own source lives. A deploy elsewhere can point it away. */
  source:
    process.env.NEXT_PUBLIC_SOURCE_URL ||
    'https://github.com/frostney/clean-code-review',
  /** One line, for the Open Graph image and the first paragraph of llms.txt. */
  tagline: 'Every code file in a pull request, judged against Clean Code.',
  /** The canonical origin. A fork deploying elsewhere sets this. */
  url:
    process.env.NEXT_PUBLIC_SITE_URL || 'https://clean-code-review.vercel.app',
} as const;
