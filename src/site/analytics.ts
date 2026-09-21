/**
 * An allowlist of what Web Analytics and Speed Insights may report: known pages
 * as-is, any pull request path as its route pattern, everything else as one
 * 404 name, never a query or fragment. The privacy page promises exactly this.
 */

import { REVIEW_PATH } from './site';

const ROOT_PATH = '/';

/** Route handlers are not page views. */
const PAGES = new Set([ROOT_PATH, '/faq', '/privacy', REVIEW_PATH]);

const PULL_REQUEST_ROUTE = '/[owner]/[repo]/pull/[number]';

const NOT_FOUND_ROUTE = '/[not-found]';

// Any path under `/pull` names a repository, not only the served route.
const PULL_REQUEST_PATH = /^\/[^/]+\/[^/]+\/pull(\/|$)/;

export function anonymousPath(pathname: string): string {
  const page =
    pathname.length > ROOT_PATH.length ? pathname.replace(/\/$/, '') : pathname;

  if (PAGES.has(page)) {
    return pathname;
  }

  return PULL_REQUEST_PATH.test(pathname)
    ? PULL_REQUEST_ROUTE
    : NOT_FOUND_ROUTE;
}

// Absolute from the scripts; the relative branch is defensive.
function anonymousUrl(url: string): string {
  // Not `URL.canParse`: some browsers in Next's default targets lack it.
  try {
    const parsed = new URL(url);

    return `${parsed.origin}${anonymousPath(parsed.pathname)}`;
  } catch {
    return anonymousPath(url.split(/[?#]/, 1)[0] ?? url);
  }
}

export function anonymousEvent<Event extends { url: string }>(
  event: Event,
): Event {
  return { ...event, url: anonymousUrl(event.url) };
}
