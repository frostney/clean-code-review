/**
 * A spend brake shared by every caller of one scope: what the models actually
 * cost, counted per clock hour and per UTC day, and a yes or no on whether new
 * model work may start.
 *
 * The counters live in the same store as the judge cache (`./cache.ts`): the
 * Vercel Runtime Cache on a deploy, this process's memory anywhere else. The
 * project runs in one region, so on Vercel that is one store for every
 * function instance, and a brake here holds across all of them where a
 * per-address count in one instance's memory cannot.
 *
 * Each record is a read, an add and a write, with no lock. Two records that
 * land in the same few milliseconds can lose one of the two amounts, and every
 * call that passed the check before the cap was crossed still finishes. So the
 * store can end above its cap, by at most the calls in flight when it crossed
 * (each bounded by the caller's own per-call worst case, and in flight for no
 * longer than the function's `maxDuration`) plus the rare amount a collision
 * drops. That overshoot is bounded because nothing admitted after the crossing
 * starts: every new call checks first, and the hour's count only grows.
 */
import { cacheGet, cacheSet } from './cache';

/** Where the counters are read and written. Injected by a test; the cache otherwise. */
export interface SpendStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: number, ttlSeconds: number): Promise<void>;
}

/** The most one scope may spend, in US dollars, per clock hour and per UTC day. */
export interface SpendCaps {
  hourUsd: number;
  dayUsd: number;
}

/** Whether new model work may start, and when the spent window resets if not. */
export type SpendCheck =
  | { ok: true }
  | {
      ok: false;
      window: 'hour' | 'day';
      spentUsd: number;
      capUsd: number;
      /** When that window's count starts again from nothing. */
      resetsAt: Date;
    };

export interface SpendBrake {
  /** Ask before starting model work. */
  check(now?: Date): Promise<SpendCheck>;
  /** Add what finished work really cost. A zero or a non-number records nothing. */
  record(costUsd: number, now?: Date): Promise<void>;
}

const MS_PER_HOUR = 3_600_000;
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;

/**
 * A counter outlives its own window by one more, so that a window read just
 * after it ends still finds the right key; it is never read after that.
 */
const HOUR_KEY_TTL_SECONDS = 2 * SECONDS_PER_HOUR;
const DAY_KEY_TTL_SECONDS = 2 * HOURS_PER_DAY * SECONDS_PER_HOUR;

/** How much of an ISO timestamp names the UTC hour (`2026-09-18T14`) and the UTC day (`2026-09-18`). */
const HOUR_CHARS = 13;
const DAY_CHARS = 10;

const hourOf = (now: Date) => now.toISOString().slice(0, HOUR_CHARS);
const dayOf = (now: Date) => now.toISOString().slice(0, DAY_CHARS);

const nextHour = (now: Date) =>
  new Date(Math.floor(now.getTime() / MS_PER_HOUR + 1) * MS_PER_HOUR);
const nextDay = (now: Date) =>
  new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );

/** The shared cache, under the name its entries are listed by. */
const cacheStore: SpendStore = {
  get: (key) => cacheGet<unknown>(key),
  set: (key, value, ttl) => cacheSet(key, value, 'model-spend', ttl),
};

/** A stored amount, or nothing when the key is missing or holds something else. */
async function read(store: SpendStore, key: string): Promise<number> {
  try {
    const value = await store.get(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** A brake for one scope, such as `mcp`. Separate scopes never count against each other. */
export function createSpendBrake(
  scope: string,
  caps: SpendCaps,
  store: SpendStore = cacheStore,
): SpendBrake {
  const hourKey = (now: Date) => `spend:${scope}:hour:${hourOf(now)}`;
  const dayKey = (now: Date) => `spend:${scope}:day:${dayOf(now)}`;
  return {
    async check(now = new Date()) {
      const [hour, day] = await Promise.all([
        read(store, hourKey(now)),
        read(store, dayKey(now)),
      ]);
      // The day first: when both are spent, the later reset is the true one.
      if (day >= caps.dayUsd) {
        return {
          capUsd: caps.dayUsd,
          ok: false,
          resetsAt: nextDay(now),
          spentUsd: day,
          window: 'day',
        };
      }
      if (hour >= caps.hourUsd) {
        return {
          capUsd: caps.hourUsd,
          ok: false,
          resetsAt: nextHour(now),
          spentUsd: hour,
          window: 'hour',
        };
      }
      return { ok: true };
    },
    async record(costUsd, now = new Date()) {
      if (!(Number.isFinite(costUsd) && costUsd > 0)) {
        return;
      }
      const add = async (key: string, ttl: number) => {
        try {
          await store.set(key, (await read(store, key)) + costUsd, ttl);
        } catch {
          /* a counter that cannot be written undercounts; it never fails a review */
        }
      };
      await Promise.all([
        add(hourKey(now), HOUR_KEY_TTL_SECONDS),
        add(dayKey(now), DAY_KEY_TTL_SECONDS),
      ]);
    },
  };
}
