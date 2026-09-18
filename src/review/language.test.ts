import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bundledLanguagesInfo } from 'shiki/langs';

import { SHIKI_NAMES } from './language';

/**
 * `language.ts` keeps its own copy of shiki's names so the page does not ship
 * shiki's registry. This is what notices when a shiki upgrade renames a
 * language, retitles one or changes its aliases: the copy has to be updated
 * with it, or chips and fence names drift from what shiki calls things.
 */
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
