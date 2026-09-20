/**
 * The Firewall rules do not exist yet, so the case that matters most is the
 * one where it cannot answer: nobody may be limited by it, and the
 * per-instance throttle must stay exactly the bound it was.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createThrottle,
  overSharedLimit,
  RETRY_AFTER_FAILURE_MS,
  RETRY_AFTER_NOT_FOUND_MS,
} from './rate-limit';

const LIMIT = 3;
const WINDOW_MS = 600_000;

const headers = new Headers({
  host: 'example.test',
  'x-real-ip': '203.0.113.7',
});

interface Answered {
  calls: number;
  restore(): void;
}

/** Next types `NODE_ENV` read-only; a test that stands in for a deployment has to set it. */
const environment = process.env as Record<string, string | undefined>;

/** Stands in for the Firewall host, which only a production deployment reaches. */
function firewallAnswers(answer: () => Response | Promise<Response>): Answered {
  const real = globalThis.fetch;
  const was = { node: environment.NODE_ENV, vercel: environment.VERCEL_ENV };
  const state: Answered = {
    calls: 0,
    restore() {
      globalThis.fetch = real;
      environment.NODE_ENV = was.node;
      environment.VERCEL_ENV = was.vercel;
    },
  };
  // The SDK short-circuits outside production before it reaches the network.
  environment.NODE_ENV = 'production';
  environment.VERCEL_ENV = 'production';
  globalThis.fetch = (async () => {
    state.calls++;
    return await answer();
  }) as typeof fetch;
  return state;
}

const status = (code: number) => () => new Response(null, { status: code });

test('the in-process throttle counts a whole IPv6 /64 as one caller', () => {
  const throttled = createThrottle(LIMIT, WINDOW_MS);
  const inOneBlock = [
    '2001:db8:1:2:3:4:5:6',
    '2001:db8:1:2::9',
    '2001:db8:1:2:aaaa::1',
  ];
  for (const address of inOneBlock) {
    assert.equal(throttled(address), false, address);
  }
  assert.equal(throttled('2001:db8:1:2::ffff'), true, 'the /64 went uncounted');
  assert.equal(throttled('2001:db8:1:3::1'), false, 'a different /64');
});

test('the in-process throttle refuses only past the limit', () => {
  const throttled = createThrottle(LIMIT, WINDOW_MS);
  for (let call = 0; call < LIMIT; call++) {
    assert.equal(throttled('203.0.113.7'), false, `call ${call}`);
  }
  assert.equal(throttled('203.0.113.7'), true);
  assert.equal(throttled('203.0.113.8'), false, 'another address');
});

test('a rule that is not configured limits nobody and is asked rarely', async () => {
  const firewall = firewallAnswers(status(404));
  const clock = Date.now;
  try {
    assert.equal(
      await overSharedLimit('absent-rule', headers, '203.0.113.7'),
      false,
    );
    assert.equal(
      await overSharedLimit('absent-rule', headers, '203.0.113.8'),
      false,
    );
    assert.equal(firewall.calls, 1, 'kept asking for a rule that is not there');
    // A rule published from the dashboard has to reach a warm instance.
    Date.now = () => clock() + RETRY_AFTER_NOT_FOUND_MS + 1;
    assert.equal(
      await overSharedLimit('absent-rule', headers, '203.0.113.7'),
      false,
    );
    assert.equal(firewall.calls, 2, 'never looked for the rule again');
  } finally {
    Date.now = clock;
    firewall.restore();
  }
});

test('a Firewall that cannot be reached limits nobody', async () => {
  const firewall = firewallAnswers(() => {
    throw new Error('connection refused');
  });
  try {
    assert.equal(
      await overSharedLimit('unreachable-rule', headers, '203.0.113.7'),
      false,
    );
  } finally {
    firewall.restore();
  }
});

test('a Firewall that failed once is asked again after the cooldown', async () => {
  const firewall = firewallAnswers(status(502));
  const clock = Date.now;
  try {
    assert.equal(
      await overSharedLimit('flaky-rule', headers, '203.0.113.7'),
      false,
    );
    assert.equal(
      await overSharedLimit('flaky-rule', headers, '203.0.113.7'),
      false,
    );
    assert.equal(firewall.calls, 1, 'asked again inside the cooldown');
    Date.now = () => clock() + RETRY_AFTER_FAILURE_MS + 1;
    assert.equal(
      await overSharedLimit('flaky-rule', headers, '203.0.113.7'),
      false,
    );
    assert.equal(firewall.calls, 2, 'never asked again after the cooldown');
  } finally {
    Date.now = clock;
    firewall.restore();
  }
});

test('a configured rule limits the caller it counts over', async () => {
  const firewall = firewallAnswers(status(429));
  try {
    assert.equal(
      await overSharedLimit('counting-rule', headers, '203.0.113.7'),
      true,
    );
  } finally {
    firewall.restore();
  }
});

test('a configured rule passes the caller it counts under', async () => {
  const firewall = firewallAnswers(status(204));
  try {
    assert.equal(
      await overSharedLimit('passing-rule', headers, '203.0.113.7'),
      false,
    );
  } finally {
    firewall.restore();
  }
});

test('nothing is asked of the Firewall outside production', async () => {
  const firewall = firewallAnswers(status(429));
  environment.VERCEL_ENV = 'preview';
  try {
    assert.equal(
      await overSharedLimit('preview-rule', headers, '203.0.113.7'),
      false,
    );
    assert.equal(firewall.calls, 0, 'reached the Firewall off production');
  } finally {
    firewall.restore();
  }
});
