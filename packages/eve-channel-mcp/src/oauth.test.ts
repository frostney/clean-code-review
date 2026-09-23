import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { OAuthResourceOptions } from 'eve/channels/auth';

import {
  metadataPath,
  metadataRoutes,
  splitChallenges,
  withResourceChallenge,
} from './oauth.js';

const OPTIONS: OAuthResourceOptions = {
  issuer: 'https://auth.example',
  scopes: ['tools:call'],
};
const REQUEST = new Request('https://agent.example/mcp', { method: 'POST' });

function refused(status: number, challenge?: string): Response {
  return new Response('{}', {
    headers: challenge ? { 'www-authenticate': challenge } : {},
    status,
  });
}

describe('metadataPath', () => {
  test('derives the RFC 9728 path from the route or the resource', () => {
    assert.equal(
      metadataPath(OPTIONS, '/mcp'),
      '/.well-known/oauth-protected-resource/mcp',
    );
    assert.equal(
      metadataPath({ ...OPTIONS, resource: 'https://agent.example/' }, '/mcp'),
      '/.well-known/oauth-protected-resource',
    );
    assert.equal(
      metadataPath({ ...OPTIONS, metadataPath: '/custom' }, '/mcp'),
      '/custom',
    );
  });
});

describe('splitChallenges', () => {
  test('keeps parameters with their scheme and commas inside quotes', () => {
    assert.deepEqual(
      splitChallenges(
        'Basic realm="a, b", charset="UTF-8", Bearer error="invalid_token"',
      ),
      ['Basic realm="a, b", charset="UTF-8"', 'Bearer error="invalid_token"'],
    );
  });
});

describe('withResourceChallenge', () => {
  const metadata =
    'resource_metadata="https://agent.example/.well-known/oauth-protected-resource/mcp"';

  test('extends an existing Bearer challenge on a 401', () => {
    const response = withResourceChallenge(
      refused(401, 'Bearer error="invalid_token"'),
      OPTIONS,
      '/mcp',
      REQUEST,
    );

    assert.equal(
      response.headers.get('www-authenticate'),
      `Bearer error="invalid_token", ${metadata}, scope="tools:call"`,
    );
  });

  test('adds a Bearer challenge beside another scheme', () => {
    const response = withResourceChallenge(
      refused(401, 'Basic realm="eve"'),
      OPTIONS,
      '/mcp',
      REQUEST,
    );

    assert.equal(
      response.headers.get('www-authenticate'),
      `Basic realm="eve", Bearer ${metadata}, scope="tools:call"`,
    );
  });

  test('leaves other refusals alone', () => {
    const forbidden = refused(403, 'Bearer error="access_denied"');

    assert.equal(
      withResourceChallenge(forbidden, OPTIONS, '/mcp', REQUEST),
      forbidden,
    );
  });
});

describe('metadataRoutes', () => {
  test('serves the metadata with any-origin CORS', async () => {
    const [get] = metadataRoutes(OPTIONS, '/mcp');
    const response = await get?.handler(
      new Request(
        'https://agent.example/.well-known/oauth-protected-resource/mcp',
      ),
      // The metadata routes read nothing from eve's route arguments.
      {} as Parameters<NonNullable<typeof get>['handler']>[1],
    );

    assert.equal(response?.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response?.json(), {
      // biome-ignore-start lint/style/useNamingConvention: RFC 9728 field names
      authorization_servers: ['https://auth.example'],
      resource: 'https://agent.example/mcp',
      scopes_supported: ['tools:call'],
      // biome-ignore-end lint/style/useNamingConvention: RFC 9728 field names
    });
  });
});
