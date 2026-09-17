/**
 * The same card as the Open Graph one. A summary_large_image tweet and a link
 * preview are the same picture; there is no second design to keep in step.
 */
import { OG_CARD } from '@/lib/og';

import OpengraphImage from './opengraph-image';

export const alt = OG_CARD.alt;
export const size = OG_CARD.size;
export const contentType = OG_CARD.contentType;

export default function Image() {
  return OpengraphImage();
}
