import type { MetadataRoute } from 'next';

import { SITE } from '@/src/site/site';

export default function manifest(): MetadataRoute.Manifest {
  return {
    background_color: '#ffffff',
    description: SITE.description,
    display: 'standalone',
    icons: [
      { sizes: '192x192', src: '/icons/icon-192.png', type: 'image/png' },
      { sizes: '512x512', src: '/icons/icon-512.png', type: 'image/png' },
    ],
    name: SITE.name,
    short_name: 'Clean Code',
    start_url: '/',
    theme_color: '#ffffff',
  };
}
