import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isolatePrincipal } from './principal.js';

const PRINCIPAL = {
  attributes: { roles: ['reader'], team: 'core' },
  authenticator: 'http-basic',
  principalId: 'ada',
  principalType: 'user',
};

describe('isolatePrincipal', () => {
  // Blocker 4: eve's walk admits any truthy result, and these reached a tool.
  test('fails closed on a malformed strategy result', () => {
    for (const malformed of [
      true,
      {},
      { ok: false },
      { ...PRINCIPAL, principalId: '' },
      { ...PRINCIPAL, attributes: undefined },
      { ...PRINCIPAL, attributes: { count: 3 } },
      { ...PRINCIPAL, issuer: 42 },
    ]) {
      assert.equal(
        isolatePrincipal(malformed),
        null,
        JSON.stringify(malformed),
      );
    }
  });

  // Blocker 7: none() and localDev() hand every caller one shared object.
  test('returns a frozen copy, so one caller cannot write into the next', () => {
    const shared = structuredClone(PRINCIPAL);
    const copy = isolatePrincipal(shared);

    assert.ok(copy);
    assert.deepEqual(copy, shared);
    assert.notEqual(copy, shared);
    assert.notEqual(copy.attributes, shared.attributes);
    assert.throws(() => {
      (copy.attributes as Record<string, unknown>).leak = 'x';
    }, TypeError);
    assert.throws(() => {
      (copy.attributes.roles as string[]).push('admin');
    }, TypeError);
    assert.equal('leak' in shared.attributes, false);
  });

  // C12: copying `__proto__` by assignment set the copy's prototype instead.
  test('keeps a __proto__ attribute a plain key', () => {
    const copy = isolatePrincipal({
      ...PRINCIPAL,
      attributes: JSON.parse('{"__proto__":["admin"],"team":"core"}'),
    });

    assert.ok(copy);
    assert.equal(Object.getPrototypeOf(copy.attributes), Object.prototype);
    assert.deepEqual(Object.keys(copy.attributes), ['__proto__', 'team']);
    assert.equal((copy.attributes as Record<string, unknown>)[0], undefined);
  });
});
