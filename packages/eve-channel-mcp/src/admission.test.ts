import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type AdmissionPolicy,
  admissionRefusal,
  deployment,
  normalizeHostname,
} from './admission.js';

const DEV = { EVE_DEV: '1' };
const VERCEL = { VERCEL: '1', VERCEL_ENV: 'production' };
const SELF_HOSTED = {};

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers, method: 'POST' });
}

function statusOf(
  target: Request,
  policy: Partial<AdmissionPolicy>,
  env: NodeJS.ProcessEnv,
): number | null {
  return (
    admissionRefusal(
      target,
      { checkOrigin: true, https: 'auto', ...policy },
      env,
    )?.status ?? null
  );
}

describe('deployment', () => {
  test('tells eve dev and vercel dev from Vercel and everything else', () => {
    assert.equal(deployment(DEV), 'dev');
    assert.equal(deployment({ VERCEL: '1', VERCEL_ENV: 'development' }), 'dev');
    assert.equal(deployment(VERCEL), 'vercel');
    assert.equal(deployment(SELF_HOSTED), 'other');
  });
});

describe('host and origin (DNS rebinding)', () => {
  // Blocker 2: Origin and Host both said attacker.example, and they matched.
  test('refuses a rebinding request whose Origin matches its own Host', () => {
    const rebound = request('http://attacker.example:3104/mcp', {
      host: 'attacker.example:3104',
      origin: 'http://attacker.example:3104',
    });

    assert.equal(statusOf(rebound, {}, DEV), 403);
  });

  test('serves loopback under eve dev, with or without a loopback Origin', () => {
    assert.equal(
      statusOf(
        request('http://127.0.0.1:3104/mcp', { host: '127.0.0.1:3104' }),
        {},
        DEV,
      ),
      null,
    );
    assert.equal(
      statusOf(
        request('http://localhost:3104/mcp', {
          host: 'localhost:3104',
          origin: 'http://localhost:3104',
        }),
        {},
        DEV,
      ),
      null,
    );
  });

  test('refuses a loopback Host with a foreign Origin', () => {
    const target = request('http://localhost:3104/mcp', {
      host: 'localhost:3104',
      origin: 'https://evil.example',
    });

    assert.equal(statusOf(target, {}, DEV), 403);
  });

  test('refuses to serve a self-hosted deployment until allowedHosts is set', () => {
    const target = request('https://mcp.example/mcp', { host: 'mcp.example' });

    assert.equal(statusOf(target, {}, SELF_HOSTED), 500);
    assert.equal(
      statusOf(
        target,
        { allowedHosts: ['mcp.example'], https: 'trusted-proxy' },
        SELF_HOSTED,
      ),
      null,
    );
  });

  test('on Vercel takes any host, and still wants a same-host Origin', () => {
    const target = (origin: string) =>
      request('https://app.example/mcp', { host: 'app.example', origin });

    assert.equal(statusOf(target('https://app.example'), {}, VERCEL), null);
    assert.equal(statusOf(target('https://evil.example'), {}, VERCEL), 403);
  });
});

describe('HTTPS', () => {
  const selfHosted = { allowedHosts: ['mcp.example'] };

  // Blocker 3: a client can send X-Forwarded-Proto itself.
  test('does not trust a forwarded scheme unless told a proxy sets it', () => {
    const spoofed = request('http://mcp.example/mcp', {
      host: 'mcp.example',
      'x-forwarded-proto': 'https',
    });

    assert.equal(statusOf(spoofed, selfHosted, SELF_HOSTED), 403);
    assert.equal(
      statusOf(spoofed, { ...selfHosted, https: 'trusted-proxy' }, SELF_HOSTED),
      null,
    );
  });

  test('refuses plain HTTP behind a trusted proxy that did not see HTTPS', () => {
    const plain = request('http://mcp.example/mcp', { host: 'mcp.example' });

    assert.equal(
      statusOf(plain, { ...selfHosted, https: 'trusted-proxy' }, SELF_HOSTED),
      403,
    );
    assert.equal(
      statusOf(plain, { ...selfHosted, https: 'off' }, SELF_HOSTED),
      null,
    );
  });

  test('refuses plain HTTP on Vercel and in dev off loopback', () => {
    assert.equal(
      statusOf(
        request('http://app.example/mcp', { host: 'app.example' }),
        {},
        VERCEL,
      ),
      403,
    );
    assert.equal(
      statusOf(
        request('http://10.0.0.5/mcp', { host: '10.0.0.5' }),
        { allowedHosts: ['10.0.0.5'] },
        DEV,
      ),
      403,
    );
  });
});

describe('normalizeHostname', () => {
  test('lower-cases a hostname and refuses anything more', () => {
    assert.equal(normalizeHostname('MCP.Example'), 'mcp.example');
    assert.equal(normalizeHostname('[::1]'), '[::1]');
    for (const bad of [
      'https://mcp.example',
      'mcp.example:443',
      'mcp.example/x',
    ]) {
      assert.throws(
        () => normalizeHostname(bad),
        /bare hostname|not a hostname/,
      );
    }
  });
});
