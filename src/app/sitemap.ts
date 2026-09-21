import type { MetadataRoute } from 'next';

import { SITE } from '@/src/site/site';

// Google reads `lastmod` and ignores `changefreq` and `priority`. Build time is
// the honest answer for pages whose text ships with the deployment.
const BUILT_AT = new Date();

const APP_PRIORITY = 1;
const SUPPORTING_PAGE_PRIORITY = 0.6;
const LEGAL_PAGE_PRIORITY = 0.3;

// Permalinks are deliberately absent: `noindex`, and disallowed in robots.txt.
// So is `/review`, which is an address a pasted review is given rather than a
// page with anything to index.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      changeFrequency: 'weekly',
      lastModified: BUILT_AT,
      priority: APP_PRIORITY,
      url: SITE.url,
    },
    {
      changeFrequency: 'monthly',
      lastModified: BUILT_AT,
      priority: SUPPORTING_PAGE_PRIORITY,
      url: `${SITE.url}/faq`,
    },
    {
      changeFrequency: 'yearly',
      lastModified: BUILT_AT,
      priority: LEGAL_PAGE_PRIORITY,
      url: `${SITE.url}/privacy`,
    },
  ];
}
