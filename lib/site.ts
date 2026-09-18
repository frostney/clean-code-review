/**
 * Who this page says it is, in one place. The metadata, the Open Graph image,
 * robots.txt, the sitemap, llms.txt and the footer all describe the same
 * product, so they read from the same few strings rather than four copies that
 * drift apart.
 */
export const SITE = {
  /** Robert C. Martin's own site. */
  author: 'https://cleancoder.com',
  /**
   * The book the questions are drawn from, on its publisher's page. The first
   * edition, because that is the one whose chapters the question set follows,
   * its smells chapter included; the 2025 second edition is a rewrite.
   */
  // biome-ignore lint/security/noSecrets: a public book page, not a credential
  book: 'https://www.informit.com/store/clean-code-a-handbook-of-agile-software-craftsmanship-9780132350884',
  /** ~150 characters: what a search result or a chat answer quotes. */
  description:
    "Paste a GitHub pull request, a diff or a codebase. Jev, TypeSafe's evaluation model, judges the code file by file against Clean Code and Luna writes the review.",
  eve: 'https://eve.dev',
  /** Jev on the AI Gateway, and the framework the agent runs on. */
  jev: 'https://vercel.com/ai-gateway/models/jev',
  name: 'Clean Code Review',
  /** Where this page's own source lives. A deploy elsewhere can point it away. */
  source:
    process.env.NEXT_PUBLIC_SOURCE_URL ||
    'https://github.com/frostney/clean-code-review',
  /** One line, for the Open Graph image and the first paragraph of llms.txt. */
  tagline: 'Code in a pull request, judged file by file against Clean Code.',
  /** The canonical origin. A fork deploying elsewhere sets this. */
  url:
    process.env.NEXT_PUBLIC_SITE_URL || 'https://clean-code-review.vercel.app',
} as const;
