/**
 * Where a pasted or example review is shown. One address for all of them: it
 * makes opening one a page view like any other, and names no code.
 */
export const REVIEW_PATH = '/review';

// The one source for metadata, OG image, robots, sitemap, llms.txt and footer.
export const SITE = {
  author: 'https://cleancoder.com',
  /** First edition: the question set follows its chapters; the 2025 edition is a rewrite. */
  // biome-ignore lint/security/noSecrets: a public book page, not a credential
  book: 'https://www.informit.com/store/clean-code-a-handbook-of-agile-software-craftsmanship-9780132350884',
  /** ~150 characters: what a search result quotes. */
  description:
    "Paste a GitHub pull request, a diff or a codebase. Jev, TypeSafe's evaluation model, judges the code file by file against Clean Code and Luna writes the review.",
  eve: 'https://eve.dev',
  jev: 'https://vercel.com/ai-gateway/models/jev',
  name: 'Clean Code Review',
  /** Overridable for forks. */
  source:
    process.env.NEXT_PUBLIC_SOURCE_URL ||
    'https://github.com/frostney/clean-code-review',
  tagline: 'Code in a pull request, judged file by file against Clean Code.',
  /** Canonical origin; overridable for forks. */
  url:
    process.env.NEXT_PUBLIC_SITE_URL || 'https://clean-code-review.vercel.app',
} as const;
