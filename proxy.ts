import { type NextRequest, NextResponse } from 'next/server';

import {
  MARKDOWN_TYPE,
  markdownFor,
  notFoundMarkdown,
  wantsMarkdown,
} from '@/src/site/agent-markdown';

/**
 * Markdown content negotiation, for the whole site, in one place.
 *
 * A request carrying `Accept: text/markdown` gets the Markdown twin of the page
 * it asked for (`src/site/agent-markdown.ts` writes them); everything else gets the
 * page. This is the only layer that sees every route before the router does,
 * which is what makes it the right one: the alternative is a route handler per
 * page, and a page added without one would quietly stop negotiating.
 *
 * ## What it must not touch
 *
 * The agent is served by eve at `/eve/v1`, through a `beforeFiles` rewrite that
 * `withEve` adds to the Next config. A proxy runs *before* those rewrites, so
 * anything answered here never reaches eve at all — hence the matcher below,
 * which keeps this function away from `/eve`, `/api`, `/_next` and the files
 * served for their own bytes, and the guard inside it for the two metadata
 * image routes, which have no extension to be excluded by.
 *
 * React's own navigations need no exclusion. Next strips its Flight headers
 * (`rsc`, `next-router-state-tree`, `next-router-prefetch`) from the request
 * inside a proxy, precisely so that an RSC request cannot be answered
 * differently from the HTML one, so there is nothing here to test them by. What
 * stands in for that test is `wantsMarkdown`, which matches `text/markdown` by
 * name and never by wildcard: an RSC request asks for `text/x-component` and a
 * browser for `text/html`, and neither has ever asked for this.
 *
 * ## Vary, and why the Markdown is not cached by anything shared
 *
 * Two representations of one URL need `Vary: Accept` on both of them, or a
 * shared cache that stored one is free to hand it to a request that wanted the
 * other. The Markdown side carries it. The HTML side cannot: the App Router
 * writes its own `Vary` (`rsc, next-router-state-tree, …`) over whatever came
 * before it, and it does so late enough to beat both a header set here and a
 * `headers()` entry in `next.config.ts`. Both were measured under
 * `next start` on 16.3.4; an unrelated header set the same way survives from
 * either place, so it is `Vary` specifically that is lost, not the mechanism.
 * The line below is kept because it is the correct thing to say and it is free
 * where a platform applies proxy headers after the render.
 *
 * So the Markdown is marked `private` instead: no shared cache may store it,
 * only the client that asked for it, and the representation a CDN could get
 * wrong is one it never holds. That also settles what this does to the
 * prerendered `/`: nothing. It stays one object on the CDN under its own URL,
 * because the only response whose body depends on the Accept header is the one
 * that refuses to be cached in front of a second reader — and on Vercel the
 * proxy runs ahead of the cache anyway, so an agent's request is answered here
 * rather than out of it.
 */

const OK = 200;
const NOT_FOUND = 404;

/** An hour in the asking client's own cache, and in nothing that is shared. */
const MARKDOWN_CACHE = 'private, max-age=3600';

/** Routes with no extension to be excluded by, and no Markdown twin: the generated cards. */
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
      // A path that names nothing is not worth an hour: the next deploy may
      // well add it.
      'cache-control': page ? MARKDOWN_CACHE : 'no-store',
      'content-type': MARKDOWN_TYPE,
      vary: 'Accept',
    },
    // A path with no page is a 404 in Markdown exactly as it is in HTML. The
    // status is the answer; the body only explains it.
    status: page ? OK : NOT_FOUND,
  });
}

export const config = {
  matcher: [
    // Everything that is a page: not eve's agent endpoints, not the route
    // handlers, not the build output, not Vercel's own `/_vercel/` paths
    // (Speed Insights' default script and beacon), and not a file served for
    // its own bytes. The extension list is anchored at the end of the path so
    // that a repository with a dot in its name still reaches the permalink
    // route.
    // On Vercel, Speed Insights may instead use a per-build path of its own,
    // `/<unique-path>/script.js` and `/<unique-path>/vitals`. The script is a
    // `.js` and excluded below; the beacon cannot be named here, and needs no
    // exclusion: it is a POST whose Accept is not `text/markdown`, so it goes
    // through untouched on the `NextResponse.next()` branch above.
    // biome-ignore lint/security/noSecrets: a path matcher, not a credential
    '/((?!api/|_next/|_vercel/|_eve_internal/|eve/|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|txt|xml|json|webmanifest|css|js|map)$).*)',
  ],
};
