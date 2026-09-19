import type { MetadataRoute } from 'next';

import { SITE } from '@/src/site/site';

// Permalinks are deliberately absent: `noindex`, and disallowed in robots.txt.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { changeFrequency: 'weekly', priority: 1, url: SITE.url },
    { changeFrequency: 'monthly', priority: 0.6, url: `${SITE.url}/faq` },
    { changeFrequency: 'yearly', priority: 0.3, url: `${SITE.url}/privacy` },
  ];
}
