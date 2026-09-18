'use client';

import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { usePathname } from 'next/navigation';
import { Suspense } from 'react';

import { anonymousEvent, anonymousPath } from './analytics';

/**
 * The two environment strings the `next` wrappers read and the React entries
 * do not: where Vercel serves the scripts and their intake for this
 * deployment.
 */
const BASE_PATH = process.env.NEXT_PUBLIC_VERCEL_OBSERVABILITY_BASEPATH;
const CONFIG = process.env.NEXT_PUBLIC_VERCEL_OBSERVABILITY_CLIENT_CONFIG;

/**
 * Vercel Web Analytics and Speed Insights, with no pull request in either.
 *
 * The React entries rather than the `next` ones. Each `next` wrapper works out
 * a route from `useParams` and hands it to its script beside the address, and
 * the scripts send that route without passing it through `beforeSend`. A
 * review opened from the landing page moves the address with
 * `history.pushState`, where there are no params, so that route would be the
 * raw `/owner/repo/pull/123`. Here the route is collapsed before either script
 * sees it, and `beforeSend` cleans the address.
 *
 * Web Analytics still gets the real path as `path`: it only decides when a
 * page view is new and which address the script starts from, and that address
 * goes through `beforeSend`. Collapsing it as well would merge two reviews
 * opened one after the other into one page view. A path that is not one of
 * the site's own pages is lower-cased, because the page corrects
 * `/Facebook/React/pull/2` to the spelling it fetched with `replaceState`, and
 * that is one view, not two.
 */
function Scripts() {
  const path = usePathname();
  const route = anonymousPath(path);
  const view = route === path ? path : path.toLowerCase();

  return (
    <>
      <Analytics
        basePath={BASE_PATH}
        beforeSend={anonymousEvent}
        configString={CONFIG}
        framework="next"
        path={view}
        route={route}
      />
      <SpeedInsights
        basePath={BASE_PATH}
        beforeSend={anonymousEvent}
        configString={CONFIG}
        framework="next"
        route={route}
      />
    </>
  );
}

/** Nothing on screen, so nothing for the page to wait on. */
export function Measurement() {
  return (
    <Suspense fallback={null}>
      <Scripts />
    </Suspense>
  );
}
