import type { MetadataRoute } from 'next';

import { SITE } from '@/src/site/site';

/** Link-preview bots: allowed onto permalinks so a shared review unfurls. */
const UNFURLERS = [
  'Twitterbot',
  'facebookexternalhit',
  'Slackbot-LinkExpanding',
  'Slackbot',
  'LinkedInBot',
  'Discordbot',
  'TelegramBot',
  'WhatsApp',
  'Bluesky Cardyb',
  'Mastodon',
];

/**
 * Permalinks are disallowed: each crawl fetches someone's pull request from
 * GitHub on this site's rate limit, and `noindex` is only read after that
 * fetch. Unfurlers fetch one page per paste, bounded by the route's throttle.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    host: SITE.url,
    rules: [
      { allow: '/', disallow: '/*/*/pull/', userAgent: '*' },
      { allow: '/', userAgent: UNFURLERS },
    ],
    sitemap: `${SITE.url}/sitemap.xml`,
  };
}
