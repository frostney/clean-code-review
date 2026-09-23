import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createSchedule } from './schedule.js';

const CANCELLED = 'cancelled';
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('createSchedule', () => {
  test('runs no more than the limit at once', async () => {
    const schedule = createSchedule(1);
    const controller = new AbortController();
    let running = 0;
    let peak = 0;
    const work = async () => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;

      return 'done';
    };

    await Promise.all(
      [1, 2, 3].map(() => schedule(controller.signal, work, () => CANCELLED)),
    );
    assert.equal(peak, 1);
  });

  // C5: after a disconnect, queued calls still started with an aborted signal.
  test('drops queued calls when the client goes, and never starts them', async () => {
    const schedule = createSchedule(1);
    const controller = new AbortController();
    const started: number[] = [];
    let finishFirst: () => void = () => undefined;
    const first = schedule(
      controller.signal,
      () =>
        new Promise<string>((resolve) => {
          started.push(1);
          finishFirst = () => resolve('first');
        }),
      () => CANCELLED,
    );
    const queued = [2, 3].map((n) =>
      schedule(
        controller.signal,
        async () => {
          started.push(n);

          return 'late';
        },
        () => CANCELLED,
      ),
    );

    await tick();
    controller.abort();
    finishFirst();
    assert.deepEqual(await Promise.all(queued), [CANCELLED, CANCELLED]);
    assert.equal(await first, 'first');
    assert.deepEqual(started, [1]);
  });

  test('frees the slot a dropped call held its place for', async () => {
    const schedule = createSchedule(1);
    const gone = new AbortController();
    const live = new AbortController();
    let finishFirst: () => void = () => undefined;
    const first = schedule(
      live.signal,
      () =>
        new Promise<string>((resolve) => (finishFirst = () => resolve('a'))),
      () => CANCELLED,
    );
    const dropped = schedule(
      gone.signal,
      async () => 'b',
      () => CANCELLED,
    );
    const after = schedule(
      live.signal,
      async () => 'c',
      () => CANCELLED,
    );

    await tick();
    gone.abort();
    finishFirst();
    assert.deepEqual(await Promise.all([first, dropped, after]), [
      'a',
      CANCELLED,
      'c',
    ]);
  });
});
