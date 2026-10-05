import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filesFromPatch } from './patch';

test('a pull request diff never hands a config file to the judge', () => {
  const diff = ['src/a.ts', 'package.json']
    .map((path) =>
      [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n'),
    )
    .join('\n');

  assert.deepEqual(
    filesFromPatch(diff).map((f) => f.path),
    ['src/a.ts'],
  );
});
