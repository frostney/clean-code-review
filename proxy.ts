import { type NextRequest, NextResponse } from 'next/server';

import {
  MARKDOWN_TYPE,
  markdownFor,
  notFoundMarkdown,
  wantsMarkdown,
} from '@/src/site/agent-markdown';

/**
 * Markdown content negotiation for every page, here rather than per route so a
 * new page cannot silently miss it.
 *
 * A proxy runs before `withEve`'s `beforeFiles` rewrite, so the matcher must
 * keep `/eve` (and `/api`, `/_next`, static files) out, and the image routes,
 * which have no extension, are skipped explicitly.
 *
 * Vary: the App Router overwrites `Vary` on HTML responses (measured under
 * `next start` on 16.3.4, both from here and from `next.config.ts` headers), so
 * the HTML-side `Vary: Accept` is kept only for platforms that apply it after
 * render. The Markdown is therefore `private`: no shared cache can serve it
 * for HTML, and the prerendered `/` stays one CDN object.
 */

const OK = 200;
const NOT_FOUND = 404;

const MARKDOWN_CACHE = 'private, max-age=3600';

const IMAGE_ROUTES = new Set(['/opengraph-image', '/twitter-image']);

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (IMAGE_ROUTES.has(pathname)) {
    return NextResponse.next();
  }

  if (!wantsMarkdown(request.headers.get('accept'))) {
    const html = NextResponse.next();
    html.headers.append('Vary', 'Accept');
    return html;
  }

  const page = markdownFor(pathname);
  return new NextResponse(page ?? notFoundMarkdown(pathname), {
    headers: {
      // The next deploy may add the missing page.
      'cache-control': page ? MARKDOWN_CACHE : 'no-store',
      'content-type': MARKDOWN_TYPE,
      vary: 'Accept',
    },
    status: page ? OK : NOT_FOUND,
  });
}

export const config = {
  matcher: [
    // Extensions are anchored at the end so a repository with a dot in its
    // name still reaches the permalink route. Speed Insights' per-build beacon
    // path cannot be named here; it is a POST without a Markdown Accept, so it
    // passes through `NextResponse.next()`.
    // biome-ignore lint/security/noSecrets: a path matcher, not a credential
    '/((?!api/|_next/|_vercel/|_eve_internal/|eve/|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|txt|xml|json|webmanifest|css|js|map)$).*)',
  ],
};
