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
