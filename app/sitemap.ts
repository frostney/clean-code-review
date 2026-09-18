import type { MetadataRoute } from 'next';

import { SITE } from '@/lib/site';

/**
 * The three pages worth indexing, said plainly, so a canonical URL is never
 * guessed at. The pull request permalinks are deliberately absent: they render
 * somebody else's change, they say `noindex`, and robots.txt keeps crawlers
 * off them.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { changeFrequency: 'weekly', priority: 1, url: SITE.url },
    { changeFrequency: 'monthly', priority: 0.6, url: `${SITE.url}/faq` },
    { changeFrequency: 'yearly', priority: 0.3, url: `${SITE.url}/privacy` },
  ];
}
