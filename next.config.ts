import { withEve } from 'eve/next';
import type { NextConfig } from 'next';

// No `images.remotePatterns`. The one remote image this page shows is the
// avatar of the project being reviewed, and it is drawn `unoptimized` with
// GitHub sizing it: allowing a host here opens `/_next/image`, which answers
// anyone and bills per transformation, as a proxy for every image on it.
const nextConfig: NextConfig = {
  // `strict-origin` rather than the browser's default: a link out, a GitHub
  // avatar and the page-view and page-speed beacons to this site's own domain
  // all carry the origin alone, never a pull request's path. Nothing here
  // reads a full Referer: server actions check `Origin`, and eve and the
  // Markdown proxy read neither.
  headers() {
    return Promise.resolve([
      {
        headers: [{ key: 'Referrer-Policy', value: 'strict-origin' }],
        source: '/:path*',
      },
    ]);
  },
};

export default withEve(nextConfig);
