import type { MetadataRoute } from 'next';

import { SITE } from '@/src/site/site';

/** The bots that fetch a page to show its card in a chat or a feed. */
const UNFURLERS = [
  'Twitterbot',
  'facebookexternalhit',
  // biome-ignore lint/security/noSecrets: a user-agent name, not a credential
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
 * Everything here is public and meant to be read, by people and by crawlers —
 * except the permalinks, which are not this site's pages to give away.
 *
 * Every `/owner/repo/pull/123` fetches somebody else's pull request from
 * GitHub, and a crawler walking them would spend this site's rate limit on
 * copies of pages GitHub already has. The route says `noindex` too, but a
 * crawler reads that only after the crawl has already cost the fetch; this is
 * the line that is read first.
 *
 * The link unfurlers are the exception: a permalink pasted into a chat is
 * meant to show the pull request's own title, and those bots honour
 * robots.txt too, so they are named and let through. They fetch one page per
 * paste, and the rate limit on the route bounds even that.
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
