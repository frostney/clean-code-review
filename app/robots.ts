import type { MetadataRoute } from 'next';

import { SITE } from '@/lib/site';

/**
 * Everything here is public and meant to be read, by people and by crawlers —
 * except the permalinks, which are not this site's pages to give away.
 *
 * Every `/owner/repo/pull/123` fetches somebody else's pull request from
 * GitHub, and a crawler walking them would spend this site's rate limit on
 * copies of pages GitHub already has. The route says `noindex` too, but a
 * crawler reads that only after the crawl has already cost the fetch; this is
 * the line that is read first.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    host: SITE.url,
    rules: [{ allow: '/', disallow: '/*/*/pull/', userAgent: '*' }],
    sitemap: `${SITE.url}/sitemap.xml`,
  };
}
