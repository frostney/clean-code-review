import { SITE } from './site';

// Shared by the Open Graph and Twitter image routes, which draw one card.
export const OG_CARD = {
  alt: `${SITE.name} — ${SITE.tagline}`,
  contentType: 'image/png',
  size: { height: 630, width: 1200 },
} as const;
