/**
 * A spend brake shared by every caller of one scope: what the models cost,
 * counted per clock hour and per UTC day, and a yes or no on whether new model
 * work may start.
 *
 * Work reserves before it starts and settles when it reports. A caller works
 * out what it is about to do that the cache cannot answer, prices that at a
 * conservative estimate (`JEV_FILE_ESTIMATE_USD` per file Jev has to judge,
 * `lunaPartEstimateUsd` per review part Luna has to write), and asks
 * `reserve` for it. The estimate is added to the counters before any model
 * runs, so the next caller sees it at once, and is then replaced by the real
 * cost when the work reports it. Work that never reports, because it failed,
 * was cancelled or timed out, keeps its reservation: it was probably paid for
 * in part, and nobody will ever say how much. Work that needs no model
 * reserves nothing and is never refused.
 *
 * A reservation is refused when it would take the hour or the day past its
 * cap, so the counters stay at or below the caps apart from what the next
 * paragraph describes, and a turn too big for what is left waits even while a
 * smaller one still fits.
 *
 * The counters live in the same store as the judge cache (`./cache.ts`): the
 * Vercel Runtime Cache on a deploy, this process's memory anywhere else. The
 * project runs in one region, so on Vercel that is one store for every
 * function instance. The Runtime Cache has no atomic increment, so every
 * reservation and every settlement is a read, an add and a write with no lock.
 * Two of them that land within one round trip of each other can both read the
 * same value, and the second write loses the first one's amount. Under a burst
 * that is not bounded by anything here: every turn that reads the counter
 * before any of the others has written admits itself against the same total,
 * and each lost write also hides that turn's reservation from turns after it.
 * What bounds a burst in practice is the Vercel Firewall's per-address limits
 * and how quickly one write lands; this brake only makes the window a round
 * trip wide instead of a whole turn wide.
 *
 * When the counters cannot be read, uncached work is refused: a brake that
 * reads a failure as zero is no brake. When a write fails the turn still runs,
 * and both are logged once per instance so they show in the function logs.
 */
import { CacheUnavailableError, cacheGetStrict, cacheSetStrict } from './cache';
import { REVIEW_LIMITS } from './review';

/**
 * Where the counters are read and written. Injected by a test; the shared
 * cache otherwise. `get` resolves undefined for a missing key and throws when
 * the store cannot be read, and `set` throws when it cannot be written.
 */
export interface SpendStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: number, ttlSeconds: number): Promise<void>;
}

/** The most one scope may spend, in US dollars, per clock hour and per UTC day. */
export interface SpendCaps {
  hourUsd: number;
  dayUsd: number;
}

/** Why new model work may not start, and when to ask again. */
export interface SpendRefusal {
  ok: false;
  /** `unavailable` when the counters could not be read at all. */
  window: 'hour' | 'day' | 'unavailable';
  spentUsd: number;
  capUsd: number;
  /** When that window's count starts again from nothing, or when to try reading it again. */
  resetsAt: Date;
}

/** Money set aside for work that has started, until the work reports what it cost. */
export interface Hold {
  readonly reservedUsd: number;
  /**
   * Replace the reservation with what the work really cost. Called once; a
   * later call does nothing. Never called for work that never reported, which
   * is how that work keeps its reservation.
   */
  settle(actualUsd: number): Promise<void>;
}

type Admission = { ok: true; hold: Hold } | SpendRefusal;

export interface SpendBrake {
  /** Set aside `estimateUsd` for work about to start, or refuse it. */
  reserve(estimateUsd: number, now?: Date): Promise<Admission>;
}

/**
 * Model prices, from the AI Gateway's model list
 * (https://ai-gateway.vercel.sh/v1/models, read 2026-09-18). Luna's are the
 * `pricing.regional.us` rates, a tenth above its list price, because the
 * project runs in iad1 and a floor that errs should err high.
 */
const JEV_INPUT_USD_PER_TOKEN = 0.000_000_042;
const LUNA_INPUT_USD_PER_TOKEN = 0.000_000_44;
const LUNA_OUTPUT_USD_PER_TOKEN = 0.000_002_64;

/** Fewer characters per token than English prose has, so a count from characters errs high. */
const CHARS_PER_TOKEN = 3;

/** Every question's wording, the path and the note Jev is shown beside the code, generously. */
const JEV_QUESTION_CHARS = 6000;

/**
 * What Jev is shown for one file at the per-file cap: the code after the
 * change and the diff, two copies of up to the cap, and the questions.
 */
const JEV_MAX_STATE_CHARS =
  2 * REVIEW_LIMITS.maxCharsPerFile + JEV_QUESTION_CHARS;

/**
 * What one uncached file is reserved at: Jev at the largest input it can be
 * sent, and twice, because a stuck first attempt is retried once and may have
 * been paid for too. Jev charges nothing for output. About a tenth of a cent.
 */
export const JEV_FILE_ESTIMATE_USD =
  2 * (JEV_MAX_STATE_CHARS / CHARS_PER_TOKEN) * JEV_INPUT_USD_PER_TOKEN;

/**
 * What one uncached review part is reserved at: its whole prompt counted at
 * three characters a token, and its output at the full ceiling it is given.
 */
export function lunaPartEstimateUsd(
  promptChars: number,
  maxOutputTokens: number,
): number {
  return (
    (promptChars / CHARS_PER_TOKEN) * LUNA_INPUT_USD_PER_TOKEN +
    maxOutputTokens * LUNA_OUTPUT_USD_PER_TOKEN
  );
}

/** A gateway cost as a number, or null when it is missing, not a number, or a zero. */
function reportedCost(cost: unknown): number | null {
  const n =
    typeof cost === 'string' || typeof cost === 'number'
      ? Number(cost)
      : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * What a Jev call cost: the gateway's figure, or, when the gateway sent none
 * (or a zero), its input tokens at list price. Work that used tokens is never
 * a silent zero.
 */
export function jevCostUsd(gatewayCost: unknown, inputTokens: number): number {
  return (
    reportedCost(gatewayCost) ??
    Math.max(0, inputTokens) * JEV_INPUT_USD_PER_TOKEN
  );
}

/** What a Luna call cost, the same way: the gateway's figure, or the tokens at list price. */
export function lunaCostUsd(
  gatewayCost: unknown,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    reportedCost(gatewayCost) ??
    Math.max(0, inputTokens) * LUNA_INPUT_USD_PER_TOKEN +
      Math.max(0, outputTokens) * LUNA_OUTPUT_USD_PER_TOKEN
  );
}

const MS_PER_HOUR = 3_600_000;
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;

/** How long a refusal for an unreadable counter lasts before the counter is tried again. */
const UNREADABLE_RETRY_MS = 60_000;

/**
 * Below this, a settlement is the reservation and is not worth a write, and a
 * reservation that fills a cap exactly still fits it: sums of dollar
 * fractions carry floating-point dust.
 */
const EPSILON_USD = 1e-9;

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
  get: (key) => cacheGetStrict(key),
  set: (key, value, ttl) => cacheSetStrict(key, value, 'model-spend', ttl),
};

/** Each kind of store failure, logged once per instance. */
const logged = new Set<'read' | 'write'>();

function logOnce(kind: 'read' | 'write', scope: string, err: unknown): void {
  if (logged.has(kind)) {
    return;
  }
  logged.add(kind);
  const cause =
    err instanceof CacheUnavailableError || err instanceof Error
      ? err.message
      : String(err);
  console.error(
    kind === 'read'
      ? `[spend] The ${scope} spend counter could not be read, so uncached model work is refused until it can be (${cause}). Logged once per instance.`
      : `[spend] The ${scope} spend counter could not be written, so work goes uncounted until it can be (${cause}). Logged once per instance.`,
  );
}

/** A stored amount: zero for a missing key, and a throw when the store cannot say. */
async function read(store: SpendStore, key: string): Promise<number> {
  const value = await store.get(key);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Add `usd`, which may be negative, to a counter, never taking it below zero. */
async function add(
  store: SpendStore,
  key: string,
  usd: number,
  ttl: number,
): Promise<void> {
  await store.set(key, Math.max(0, (await read(store, key)) + usd), ttl);
}

/** A brake for one scope, such as `mcp`. Separate scopes never count against each other. */
export function createSpendBrake(
  scope: string,
  caps: SpendCaps,
  store: SpendStore = cacheStore,
): SpendBrake {
  /** Add to both of the windows a reservation was made in, and log a failure rather than throw it. */
  async function charge(hourKey: string, dayKey: string, usd: number) {
    try {
      await Promise.all([
        add(store, hourKey, usd, HOUR_KEY_TTL_SECONDS),
        add(store, dayKey, usd, DAY_KEY_TTL_SECONDS),
      ]);
    } catch (err) {
      logOnce('write', scope, err);
    }
  }

  function holdFor(hourKey: string, dayKey: string, reservedUsd: number): Hold {
    let settled = false;
    return {
      reservedUsd,
      async settle(actualUsd) {
        if (settled) {
          return;
        }
        settled = true;
        // A figure that is not a cost is no report at all: the reservation stands.
        if (!(Number.isFinite(actualUsd) && actualUsd >= 0)) {
          return;
        }
        const delta = actualUsd - reservedUsd;
        if (Math.abs(delta) > EPSILON_USD) {
          // Settled into the windows it was reserved in, even if the hour has turned since.
          await charge(hourKey, dayKey, delta);
        }
      },
    };
  }

  return {
    async reserve(estimateUsd, now = new Date()) {
      const hourKey = `spend:${scope}:hour:${hourOf(now)}`;
      const dayKey = `spend:${scope}:day:${dayOf(now)}`;
      const reserved =
        Number.isFinite(estimateUsd) && estimateUsd > 0 ? estimateUsd : 0;
      // Nothing to pay for: no read, no refusal. Whatever it turns out to
      // cost after all, say a cache entry that expired in between, is settled.
      if (reserved === 0) {
        return { hold: holdFor(hourKey, dayKey, 0), ok: true };
      }
      let hour: number;
      let day: number;
      try {
        [hour, day] = await Promise.all([
          read(store, hourKey),
          read(store, dayKey),
        ]);
      } catch (err) {
        logOnce('read', scope, err);
        return {
          capUsd: caps.hourUsd,
          ok: false,
          resetsAt: new Date(now.getTime() + UNREADABLE_RETRY_MS),
          spentUsd: 0,
          window: 'unavailable',
        };
      }
      // The day first: when both would be spent, the later reset is the true one.
      if (day + reserved > caps.dayUsd + EPSILON_USD) {
        return {
          capUsd: caps.dayUsd,
          ok: false,
          resetsAt: nextDay(now),
          spentUsd: day,
          window: 'day',
        };
      }
      if (hour + reserved > caps.hourUsd + EPSILON_USD) {
        return {
          capUsd: caps.hourUsd,
          ok: false,
          resetsAt: nextHour(now),
          spentUsd: hour,
          window: 'hour',
        };
      }
      // Written from the values just read rather than read again, to keep the
      // window in which another reservation can slip past as short as it goes.
      try {
        await Promise.all([
          store.set(hourKey, hour + reserved, HOUR_KEY_TTL_SECONDS),
          store.set(dayKey, day + reserved, DAY_KEY_TTL_SECONDS),
        ]);
      } catch (err) {
        logOnce('write', scope, err);
      }
      return { hold: holdFor(hourKey, dayKey, reserved), ok: true };
    },
  };
}
