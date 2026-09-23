import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  metadataResponse,
  parseChallenges,
  quoteParameter,
  resolveOAuth,
  withResourceChallenge,
} from './oauth.js';

// Behind `withEve`, only /eve/v1/* reaches eve, so the metadata lives there too.
const OAUTH = resolveOAuth({
  issuer: 'https://auth.example',
  metadataPath: '/eve/v1/oauth-protected-resource/tools',
  resource: 'https://app.example/eve/v1/tools',
  scopes: ['tools:call'],
});
const METADATA =
  'resource_metadata="https://app.example/eve/v1/oauth-protected-resource/tools"';

function refused(status: number, challenge: string): Response {
  return new Response('{}', {
    headers: { 'www-authenticate': challenge },
    status,
  });
}

function challengeOf(response: Response): string | null {
  return withResourceChallenge(response, OAUTH).headers.get('www-authenticate');
}

describe('resolveOAuth', () => {
  test('derives the RFC 9728 path when none is given', () => {
    const derived = resolveOAuth({
      issuer: 'https://auth.example',
      resource: 'https://app.example/mcp',
    });

    assert.equal(
      derived.metadataPath,
      '/.well-known/oauth-protected-resource/mcp',
    );
    assert.equal(
      derived.metadataUrl,
      'https://app.example/.well-known/oauth-protected-resource/mcp',
    );
  });

  // C8: the rules eve's oauthResource() applies, which explicit settings skipped.
  test('refuses URLs eve would refuse', () => {
    const issuer = 'https://auth.example';

    for (const resource of [
      'http://app.example/mcp',
      'https://user:pass@app.example/mcp',
      'https://app.example/mcp?token=secret',
      'https://app.example/mcp#part',
    ]) {
      assert.throws(
        () => resolveOAuth({ issuer, resource }),
        /HTTPS URL/,
        resource,
      );
    }
    for (const bad of [
      'ftp://auth.example',
      'http://auth.example',
      'https://auth.example?x=1',
    ]) {
      assert.throws(
        () =>
          resolveOAuth({ issuer: bad, resource: 'https://app.example/mcp' }),
        /HTTPS URL/,
        bad,
      );
    }
    for (const metadataPath of [
      '//evil.example/meta',
      'meta',
      '/meta?x=1',
      '/meta#x',
    ]) {
      assert.throws(
        () =>
          resolveOAuth({
            issuer,
            metadataPath,
            resource: 'https://app.example/mcp',
          }),
        /metadataPath/,
        metadataPath,
      );
    }
    assert.ok(
      resolveOAuth({
        issuer: 'http://127.0.0.1:9000',
        resource: 'http://localhost:3104/mcp',
      }),
    );
  });

  // C8: URL parsing dropped a bare ? or #, and resolved dot segments, so the
  // route was registered at one path while the metadata named another.
  test('refuses what URL parsing would silently change', () => {
    const issuer = 'https://auth.example';

    for (const metadataPath of ['/x?', '/x#', '/a/../meta', '/a/./meta']) {
      assert.throws(
        () =>
          resolveOAuth({
            issuer,
            metadataPath,
            resource: 'https://app.example/mcp',
          }),
        /metadataPath/,
        metadataPath,
      );
    }
    for (const resource of [
      'https://app.example/mcp?',
      'https://app.example/mcp#',
    ]) {
      assert.throws(
        () => resolveOAuth({ issuer, resource }),
        /HTTPS URL/,
        resource,
      );
    }
    assert.throws(
      () =>
        resolveOAuth({
          issuer: 'https://auth.example?',
          resource: 'https://app.example/mcp',
        }),
      /HTTPS URL/,
    );
  });

  test('refuses settings it cannot publish', () => {
    assert.throws(
      () => resolveOAuth({ issuer: 'https://a.example', resource: '/mcp' }),
      /absolute/,
    );
    assert.throws(
      () => resolveOAuth({ resource: 'https://app.example/mcp' }),
      /exactly one of issuer/,
    );
    assert.throws(
      () =>
        resolveOAuth({
          authorizationServers: ['https://a.example'],
          issuer: 'https://a.example',
          resource: 'https://app.example/mcp',
        }),
      /exactly one of issuer/,
    );
  });
});

describe('parseChallenges', () => {
  test('keeps parameters with their scheme and commas inside quotes', () => {
    const [basic, bearer] = parseChallenges(
      'Basic realm="a, b", charset="UTF-8", Bearer error="invalid_token"',
    );

    assert.equal(basic?.raw, 'Basic realm="a, b", charset="UTF-8"');
    assert.equal(basic?.params.get('realm'), 'a, b');
    assert.equal(bearer?.params.get('error'), 'invalid_token');
  });
});

describe('withResourceChallenge', () => {
  test('extends a 401 Bearer challenge', () => {
    assert.equal(
      challengeOf(refused(401, 'Bearer error="invalid_token"')),
      `Bearer error="invalid_token", ${METADATA}, scope="tools:call"`,
    );
  });

  test('adds a Bearer challenge beside another scheme', () => {
    assert.equal(
      challengeOf(refused(401, 'Basic realm="eve"')),
      `Basic realm="eve", Bearer ${METADATA}, scope="tools:call"`,
    );
  });

  // Item 12: a regex over the whole header found this name inside quoted text.
  test('is not fooled by a parameter name inside a quoted value', () => {
    assert.equal(
      challengeOf(
        refused(401, 'Bearer realm="a resource_metadata=placeholder"'),
      ),
      `Bearer realm="a resource_metadata=placeholder", ${METADATA}, scope="tools:call"`,
    );
  });

  test('extends the Bearer challenge that carries insufficient_scope, and only that', () => {
    assert.equal(
      challengeOf(
        refused(403, 'Bearer realm="first", Bearer error="insufficient_scope"'),
      ),
      `Bearer realm="first", Bearer error="insufficient_scope", ${METADATA}`,
    );
    assert.equal(
      challengeOf(refused(403, 'Basic realm="insufficient_scope"')),
      'Basic realm="insufficient_scope"',
    );
  });
});

describe('quoteParameter', () => {
  test('escapes quotes and backslashes and drops line breaks', () => {
    assert.equal(quoteParameter('a"b\\c\r\nd'), '"a\\"b\\\\cd"');
  });
});

describe('metadataResponse', () => {
  test('serves the metadata with any-origin CORS', async () => {
    const response = metadataResponse(
      new Request('https://app.example/x'),
      OAUTH,
    );

    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), {
      // biome-ignore-start lint/style/useNamingConvention: RFC 9728 field names
      authorization_servers: ['https://auth.example'],
      resource: 'https://app.example/eve/v1/tools',
      scopes_supported: ['tools:call'],
      // biome-ignore-end lint/style/useNamingConvention: RFC 9728 field names
    });
  });
});
