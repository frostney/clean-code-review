import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PAGE_PATHS } from './agent-markdown';
import { anonymousPath } from './analytics';

// The allowlist in `analytics.ts` is a second copy of the page list. A page
// added without it would be reported as `/[not-found]`, and the count of a page
// nobody can find is worse than no count at all.
test('every page is reported as itself', () => {
  for (const path of PAGE_PATHS) {
    assert.equal(anonymousPath(path), path, path);
  }
});

// The slash is kept rather than folded away, so `/faq` and `/faq/` are two
// rows in the dashboard. That is the allowlist's business; what matters here is
// that neither is reported as a page nobody can find.
test('a trailing slash is still that page, not the not-found name', () => {
  for (const path of PAGE_PATHS.filter((page) => page !== '/')) {
    assert.equal(anonymousPath(`${path}/`), `${path}/`, path);
  }
});

test('a pull request goes as its route, whatever it names', () => {
  assert.equal(
    anonymousPath('/vercel/next.js/pull/64000'),
    '/[owner]/[repo]/pull/[number]',
  );
  assert.equal(
    anonymousPath('/owner/repo/pull/1/files'),
    '/[owner]/[repo]/pull/[number]',
  );
});

test('anything else goes as one not-found name', () => {
  assert.equal(anonymousPath('/nope'), '/[not-found]');
  assert.equal(anonymousPath('/review/secret-project'), '/[not-found]');
});
