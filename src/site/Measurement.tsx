'use client';

import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { usePathname } from 'next/navigation';
import { Suspense } from 'react';

import { anonymousEvent, anonymousPath } from './analytics';

// Read by the `next` wrappers but not the React entries, so passed explicitly.
const BASE_PATH = process.env.NEXT_PUBLIC_VERCEL_OBSERVABILITY_BASEPATH;
const CONFIG = process.env.NEXT_PUBLIC_VERCEL_OBSERVABILITY_CLIENT_CONFIG;

/**
 * React entries, not the `next` ones: those derive `route` from `useParams`,
 * which is empty after the landing page's `pushState`, and send it without
 * `beforeSend`, leaking `/owner/repo/pull/123`.
 *
 * `path` stays real so consecutive reviews are separate views (it still goes
 * through `beforeSend`); lower-cased because the page `replaceState`s a
 * PR path to GitHub's casing, which must not count twice.
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
