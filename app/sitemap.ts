import type { MetadataRoute } from 'next';

import { SITE } from '@/lib/site';

/** One page, said plainly, so the canonical URL is never guessed at. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ changeFrequency: 'weekly', priority: 1, url: SITE.url }];
}
