import type { MetadataRoute } from 'next';

import { SITE } from '@/src/site/site';

const APP_PRIORITY = 1;
const SUPPORTING_PAGE_PRIORITY = 0.6;
const LEGAL_PAGE_PRIORITY = 0.3;

// Permalinks are deliberately absent: `noindex`, and disallowed in robots.txt.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { changeFrequency: 'weekly', priority: APP_PRIORITY, url: SITE.url },
    {
      changeFrequency: 'monthly',
      priority: SUPPORTING_PAGE_PRIORITY,
      url: `${SITE.url}/faq`,
    },
    {
      changeFrequency: 'yearly',
      priority: LEGAL_PAGE_PRIORITY,
      url: `${SITE.url}/privacy`,
    },
  ];
}
