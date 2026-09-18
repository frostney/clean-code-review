import { withEve } from 'eve/next';
import type { NextConfig } from 'next';

// No `images.remotePatterns`. The one remote image this page shows is the
// avatar of the project being reviewed, and it is drawn `unoptimized` with
// GitHub sizing it: allowing a host here opens `/_next/image`, which answers
// anyone and bills per transformation, as a proxy for every image on it.
const nextConfig: NextConfig = {};

export default withEve(nextConfig);
