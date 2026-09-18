/**
 * What the two Vercel measurements are allowed to say about where a visitor
 * was: which of this site's pages, and nothing a visitor typed.
 *
 * An allowlist rather than a list of things to hide. The site's own pages go
 * as they are; a pull request's address, which names a repository, goes as
 * the route's pattern; and every other address, which can only be a page that
 * does not exist and is whatever somebody typed, goes as one fixed value.
 * Every address also loses its query and its fragment, which both scripts
 * would otherwise send whole with `location.href`.
 *
 * Pure and free of React, so both components can share it and a test can run
 * it without a browser.
 */

/** The pages this site serves, as their paths. Route handlers are not page views. */
const PAGES = new Set(['/', '/faq', '/privacy']);

/** `app/[owner]/[repo]/pull/[number]`, as the dashboard will show it. */
const PULL_REQUEST_ROUTE = '/[owner]/[repo]/pull/[number]';

/** Everything else: a 404, under one name whatever was typed. */
const NOT_FOUND_ROUTE = '/[not-found]';

/**
 * Anything under a repository's `pull`, not only the one route this site
 * serves: `/o/r/pull/12/files` or `/o/r/pull/abc` names a repository just as
 * well, whatever page it ends on.
 */
const PULL_REQUEST_PATH = /^\/[^/]+\/[^/]+\/pull(\/|$)/;

/** A path as either script may send it. */
export function anonymousPath(pathname: string): string {
  const page = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  if (PAGES.has(page)) {
    return pathname;
  }
  return PULL_REQUEST_PATH.test(pathname)
    ? PULL_REQUEST_ROUTE
    : NOT_FOUND_ROUTE;
}

/**
 * An address as the scripts hand it to `beforeSend`, which is absolute, with
 * the pull request collapsed and the query and fragment gone. A relative one
 * is handled the same way, in case a script ever sends a path alone.
 */
function anonymousUrl(url: string): string {
  // `new URL` in a try rather than `URL.canParse`, which browsers inside
  // Next's default targets lack; a throw here would drop the event.
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${anonymousPath(parsed.pathname)}`;
  } catch {
    return anonymousPath(url.split(/[?#]/, 1)[0] ?? url);
  }
}

/** Either script's `beforeSend` event, with its address cleaned. */
export function anonymousEvent<Event extends { url: string }>(
  event: Event,
): Event {
  return { ...event, url: anonymousUrl(event.url) };
}
