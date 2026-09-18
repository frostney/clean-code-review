import { SITE } from './site';

/**
 * The link preview's frame. A summary_large_image tweet and an Open Graph link
 * preview are the same picture, so the two metadata routes describe the same
 * card from here rather than from two copies that drift apart.
 */
export const OG_CARD = {
  alt: `${SITE.name} — ${SITE.tagline}`,
  contentType: 'image/png',
  size: { height: 630, width: 1200 },
} as const;
