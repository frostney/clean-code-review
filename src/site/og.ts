import { SITE } from './site';

// Shared by the Open Graph and Twitter image routes, which draw one card.
export const OG_CARD = {
  alt: `${SITE.name} — ${SITE.tagline}`,
  contentType: 'image/png',
  size: { height: 630, width: 1200 },
} as const;

// A page that sets its own `openGraph` replaces the layout's block entirely,
// file-convention image included, so every such page names the card again.
export const OG_IMAGE = '/opengraph-image';
export const TWITTER_IMAGE = '/twitter-image';
