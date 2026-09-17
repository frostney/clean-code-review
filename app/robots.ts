import type { MetadataRoute } from 'next';

import { SITE } from '@/lib/site';

/** Everything here is public and meant to be read, by people and by crawlers. */
export default function robots(): MetadataRoute.Robots {
  return {
    host: SITE.url,
    rules: [{ allow: '/', userAgent: '*' }],
    sitemap: `${SITE.url}/sitemap.xml`,
  };
}
