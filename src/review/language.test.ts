import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bundledLanguagesInfo } from 'shiki/langs';

import { SHIKI_NAMES } from './language';

// `language.ts` copies shiki's names to keep the registry out of the bundle;
// this catches a shiki upgrade that changes them.
test('every language name matches shiki’s registry', () => {
  const registry = new Map(bundledLanguagesInfo.map((info) => [info.id, info]));
  for (const [id, row] of Object.entries(SHIKI_NAMES)) {
    const info = registry.get(id);
    assert.ok(info, `shiki no longer bundles "${id}"`);
    assert.equal(row.name, info.name, `name of "${id}"`);
    assert.deepEqual(
      [...row.aliases],
      info.aliases ?? [],
      `aliases of "${id}"`,
    );
  }
});
