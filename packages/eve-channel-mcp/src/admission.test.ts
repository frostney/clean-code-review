import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type AdmissionPolicy,
  admissionRefusal,
  deployment,
  MISCONFIGURED_MESSAGE,
  normalizeHostname,
} from './admission.js';

const DEV = { EVE_DEV: '1' };
const VERCEL = { VERCEL: '1', VERCEL_ENV: 'production' };
const SELF_HOSTED = {};
const PROXIED: Partial<AdmissionPolicy> = {
  allowedHosts: ['mcp.example'],
  https: 'trusted-proxy',
};

/** A request as the server builds it: the URL's authority comes from `Host`. */
function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    headers: { host: new URL(url).host, ...headers },
    method: 'POST',
  });
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

describe('host', () => {
  test('refuses a rebinding request whose Origin matches its own Host', () => {
    const rebound = request('http://attacker.example:3104/mcp', {
      origin: 'http://attacker.example:3104',
    });

    assert.equal(statusOf(rebound, {}, DEV), 403);
  });

  // L3: HTTPS and Origin both pass here, so only the Host check can refuse it.
  test('refuses a Host that is not on the list, on its own', () => {
    const target = request('https://other.example/mcp');

    assert.equal(
      statusOf(
        target,
        { allowedHosts: ['mcp.example'], https: 'off' },
        SELF_HOSTED,
      ),
      403,
    );
    assert.equal(
      statusOf(
        target,
        { allowedHosts: ['other.example'], https: 'off' },
        SELF_HOSTED,
      ),
      null,
    );
  });

  // C10: `anything@localhost/path` passed as localhost.
  test('refuses a Host with userinfo, path, query or fragment', () => {
    for (const host of [
      'x@localhost',
      'localhost/path',
      'localhost?q',
      'localhost#f',
      'local host',
    ]) {
      const target = new Request('http://localhost/mcp', {
        headers: { host },
        method: 'POST',
      });

      assert.equal(statusOf(target, {}, DEV), 403, host);
    }
  });

  // C10: the Host header and the URL the server built must name the same authority.
  test('refuses a Host that disagrees with the request authority, or none', () => {
    const disagreeing = new Request('http://127.0.0.1:3104/mcp', {
      headers: { host: 'localhost:3104' },
      method: 'POST',
    });
    const missing = new Request('http://127.0.0.1:3104/mcp', {
      method: 'POST',
    });

    assert.equal(statusOf(disagreeing, {}, DEV), 403);
    assert.equal(statusOf(missing, {}, DEV), 403);
  });

  test('on Vercel takes any well-formed host', () => {
    assert.equal(
      statusOf(request('https://app.example/mcp'), {}, VERCEL),
      null,
    );
  });
});

describe('origin', () => {
  test('passes a request without Origin and a same-origin one', () => {
    assert.equal(statusOf(request('http://127.0.0.1:3104/mcp'), {}, DEV), null);
    assert.equal(
      statusOf(
        request('http://127.0.0.1:3104/mcp', {
          origin: 'http://127.0.0.1:3104',
        }),
        {},
        DEV,
      ),
      null,
    );
  });

  // C11: a matching hostname on another scheme or port, or another allowed host, passed.
  test('wants the exact origin: scheme, host and port', () => {
    const allowed = {
      allowedHosts: ['app.example', 'preview.example'],
      https: 'off',
    } as const;

    for (const origin of [
      'http://app.example',
      'https://app.example:8443',
      'https://preview.example',
      'null',
    ]) {
      assert.equal(
        statusOf(
          request('https://app.example/mcp', { origin }),
          allowed,
          SELF_HOSTED,
        ),
        403,
        origin,
      );
    }
    assert.equal(
      statusOf(
        request('https://app.example/mcp', { origin: 'https://app.example' }),
        allowed,
        SELF_HOSTED,
      ),
      null,
    );
  });

  test('compares against the scheme a trusted proxy reports', () => {
    const target = request('http://mcp.example/mcp', {
      origin: 'https://mcp.example',
      'x-forwarded-proto': 'https',
    });

    assert.equal(statusOf(target, PROXIED, SELF_HOSTED), null);
  });
});

describe('HTTPS', () => {
  test('reads X-Forwarded-Proto only from a trusted proxy, never on Vercel', () => {
    const spoofed = request('http://mcp.example/mcp', {
      'x-forwarded-proto': 'https',
    });

    assert.equal(
      statusOf(spoofed, { ...PROXIED, https: 'off' }, SELF_HOSTED),
      null,
    );
    assert.equal(statusOf(spoofed, PROXIED, SELF_HOSTED), null);
    assert.equal(
      statusOf(
        request('http://app.example/mcp', { 'x-forwarded-proto': 'https' }),
        {},
        VERCEL,
      ),
      403,
    );
  });

  // C7: TLS between proxy and server must not outvote the proxy's "http".
  test('lets a present X-Forwarded-Proto decide, by its last entry', () => {
    const tlsUpstream = (proto: string) =>
      request('https://mcp.example/mcp', { 'x-forwarded-proto': proto });

    assert.equal(statusOf(tlsUpstream('http'), PROXIED, SELF_HOSTED), 403);
    assert.equal(
      statusOf(tlsUpstream('https, http'), PROXIED, SELF_HOSTED),
      403,
    );
    assert.equal(
      statusOf(tlsUpstream('http, https'), PROXIED, SELF_HOSTED),
      null,
    );
    assert.equal(
      statusOf(request('https://mcp.example/mcp'), PROXIED, SELF_HOSTED),
      null,
    );
    assert.equal(
      statusOf(request('http://mcp.example/mcp'), PROXIED, SELF_HOSTED),
      403,
    );
  });

  // C9: a loopback Host is not proof of a local connection.
  test('does not waive HTTPS for a loopback Host outside development', () => {
    const local = request('http://localhost:3104/mcp');

    assert.equal(
      statusOf(
        local,
        { allowedHosts: ['localhost'], https: 'trusted-proxy' },
        SELF_HOSTED,
      ),
      403,
    );
    assert.equal(statusOf(local, {}, DEV), null);
  });

  test('takes plain HTTP under eve dev, and not on Vercel', () => {
    assert.equal(
      statusOf(
        request('http://10.0.0.5/mcp'),
        { allowedHosts: ['10.0.0.5'] },
        DEV,
      ),
      null,
    );
    assert.equal(statusOf(request('http://app.example/mcp'), {}, VERCEL), 403);
  });
});

describe('configuration', () => {
  // L5: 'auto' can never admit a self-hosted request; say so instead of a 403 later.
  test('answers 500 naming allowedHosts and https until both are set', async () => {
    const target = request('https://mcp.example/mcp');

    for (const policy of [
      {},
      { allowedHosts: ['mcp.example'] },
      { https: 'off' as const },
    ]) {
      const refused = admissionRefusal(
        target,
        { checkOrigin: true, https: 'auto', ...policy },
        SELF_HOSTED,
      );

      assert.ok(refused);
      assert.equal(refused.status, 500);
      assert.equal((await refused.json()).error.message, MISCONFIGURED_MESSAGE);
    }
    assert.match(MISCONFIGURED_MESSAGE, /allowedHosts.*https/);
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
