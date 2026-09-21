import { OG_CARD } from '@/src/site/og';

import OpengraphImage from './opengraph-image';

export const alt = OG_CARD.alt;
export const size = OG_CARD.size;
export const contentType = OG_CARD.contentType;

export default function Image() {
  return OpengraphImage();
}
