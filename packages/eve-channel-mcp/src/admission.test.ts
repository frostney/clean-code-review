import assert from 'node:assert/strict';
import {
  connect,
  createServer,
  type Http2ServerRequest,
  type Http2ServerResponse,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
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
const LOOPBACK_PEER = '127.0.0.1';
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
  requestIp: string | null = LOOPBACK_PEER,
): number | null {
  return (
    admissionRefusal(
      target,
      { checkOrigin: true, https: 'auto', ...policy },
      env,
      requestIp,
    )?.status ?? null
  );
}

/** As srvx builds a request: pseudo-headers left out of `headers`, the Node request kept. */
function adapted(
  url: string,
  headers: Record<string, string>,
  node: { httpVersion: string; headers: Record<string, unknown> },
): Request {
  return Object.assign(new Request(url, { headers, method: 'POST' }), {
    runtime: { name: 'node', node: { req: node } },
  });
}

describe('deployment', () => {
  test('tells eve dev from Vercel and everything else', () => {
    assert.equal(deployment(DEV), 'dev');
    assert.equal(deployment({ ...VERCEL, ...DEV }), 'dev');
    assert.equal(deployment(VERCEL), 'vercel');
    assert.equal(deployment({ VERCEL: '1', VERCEL_ENV: 'preview' }), 'vercel');
    assert.equal(deployment(SELF_HOSTED), 'other');
  });

  // R5b: `eve start` loads .env.local, where `vercel env pull` can write these.
  test('does not take a pulled development environment for eve dev or Vercel', () => {
    assert.equal(
      deployment({ VERCEL: '1', VERCEL_ENV: 'development' }),
      'other',
    );
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

  // R2: srvx accepts an underscore in a host, and so does URL.
  test('takes a Host with an underscore when it is allowed', () => {
    const target = request('https://my_host:8443/mcp');

    assert.equal(
      statusOf(
        target,
        { allowedHosts: ['my_host'], https: 'off' },
        SELF_HOSTED,
      ),
      null,
    );
    assert.equal(normalizeHostname('My_Host'), 'my_host');
  });

  // R1: srvx builds the URL from `:authority`, but its headers never show it.
  test('takes the authority of an HTTP/2 request from :authority', () => {
    const http2 = (authority: string) =>
      adapted(
        'http://127.0.0.1:3104/mcp',
        {},
        { headers: { ':authority': authority }, httpVersion: '2.0' },
      );

    assert.equal(statusOf(http2('127.0.0.1:3104'), {}, DEV), null);
    assert.equal(statusOf(http2('localhost:3104'), {}, DEV), 403);
    assert.equal(statusOf(http2('x@127.0.0.1:3104'), {}, DEV), 403);
  });

  test('still wants Host on HTTP/1.1', () => {
    const http1 = adapted(
      'http://127.0.0.1:3104/mcp',
      {},
      { headers: { ':authority': '127.0.0.1:3104' }, httpVersion: '1.1' },
    );

    assert.equal(statusOf(http1, {}, DEV), 403);
  });

  // R1, end to end over Node's own HTTP/2 server, adapted the way srvx does it.
  test('admits a real HTTP/2 request without a Host header', async () => {
    const server = createServer(
      (req: Http2ServerRequest, res: Http2ServerResponse) => {
        const headers: Record<string, string> = {};

        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i] ?? '';

          if (!name.startsWith(':')) {
            headers[name] = req.rawHeaders[i + 1] ?? '';
          }
        }
        const target = Object.assign(
          new Request(`http://${req.authority}${req.url}`, {
            headers,
            method: 'POST',
          }),
          { runtime: { name: 'node', node: { req, res } } },
        );
        const refused = admissionRefusal(
          target,
          { checkOrigin: true, https: 'auto' },
          DEV,
          LOOPBACK_PEER,
        );

        res.end(String(refused?.status ?? 'admitted'));
      },
    );

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const client = connect(`http://127.0.0.1:${port}`);

    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const stream = client.request({ ':method': 'POST', ':path': '/mcp' });
        let text = '';

        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          text += chunk;
        });
        stream.on('end', () => resolve(text));
        stream.on('error', reject);
        stream.end();
      });

      assert.equal(answer, 'admitted');
    } finally {
      client.close();
      await new Promise((resolve) => server.close(resolve));
    }
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

  // R4: withEve's dev rewrite makes eve see 127.0.0.1, while the page is on localhost:3000.
  test('also takes an origin the app listed, and never "null"', () => {
    const page = request('http://127.0.0.1:3104/mcp', {
      origin: 'http://localhost:3000',
    });
    const listed = { allowedOrigins: ['http://localhost:3000'] };

    assert.equal(statusOf(page, {}, DEV), 403);
    assert.equal(statusOf(page, listed, DEV), null);
    for (const origin of ['http://localhost:3001', 'null']) {
      assert.equal(
        statusOf(request('http://127.0.0.1:3104/mcp', { origin }), listed, DEV),
        403,
        origin,
      );
    }
  });

  // A request captured on Vercel, sent through a rewrite on another project's domain.
  test('admits a rewrite from another domain on Vercel only when listed', () => {
    const rewritten = request('https://eve-mcp-probe.vercel.app/eve/v1/probe', {
      forwarded:
        'for=86.140.124.37;host=eve-mcp-probe-rewrite.vercel.app;proto=https',
      origin: 'https://eve-mcp-probe-rewrite.vercel.app',
      'x-forwarded-for': '86.140.124.37',
      'x-forwarded-host': 'eve-mcp-probe-rewrite.vercel.app',
      'x-forwarded-proto': 'https',
    });

    assert.equal(statusOf(rewritten, {}, VERCEL, '86.140.124.37'), 403);
    assert.equal(
      statusOf(
        rewritten,
        { allowedOrigins: ['https://eve-mcp-probe-rewrite.vercel.app'] },
        VERCEL,
        '86.140.124.37',
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

  // R5a: `eve dev --host 0.0.0.0` accepted plain HTTP from other machines.
  test('waives HTTPS under eve dev for a loopback peer only', () => {
    const lan = request('http://192.168.1.218:3104/mcp');
    const hosts = { allowedHosts: ['192.168.1.218'] };

    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      assert.equal(statusOf(lan, hosts, DEV, peer), null, peer);
    }
    for (const peer of ['192.168.1.218', '::ffff:192.168.1.218', null]) {
      assert.equal(statusOf(lan, hosts, DEV, peer), 403, String(peer));
    }
    assert.equal(
      statusOf(lan, { ...hosts, https: 'off' }, DEV, '192.168.1.218'),
      null,
    );
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
        LOOPBACK_PEER,
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
