import { withEve } from 'eve/next';
import type { NextConfig } from 'next';

// No `images.remotePatterns`: allowing GitHub would open `/_next/image` as a
// public, per-transformation-billed proxy. The avatar is drawn `unoptimized`.
const nextConfig: NextConfig = {
  // `strict-origin`, so no request carries a pull request's path; nothing here
  // reads a full Referer (server actions check `Origin`).
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
