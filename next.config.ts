import { withEve } from 'eve/next';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    // The one remote host this page shows an image from: the avatar of the
    // owner of the pull request being reviewed. The host serves avatars and
    // nothing else, so the whole of it is named rather than a path inside it —
    // GitHub writes user, organisation and app avatars under different
    // prefixes and a pull request can come from any of them.
    remotePatterns: [
      { hostname: 'avatars.githubusercontent.com', protocol: 'https' },
    ],
  },
};

export default withEve(nextConfig);
