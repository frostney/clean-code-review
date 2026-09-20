/**
 * Per-scope spend brake: model cost counted per UTC hour and day, checked
 * before new model work starts. The Runtime Cache is per region, so the caps
 * are global only while the project runs in one region.
 *
 * Work reserves a worst-case estimate before any model runs, so concurrent
 * callers see it at once, then settles to what it plausibly cost. Settling at
 * the worst case would let cancelled work lock the page. Zero-cost work is
 * never refused. A reservation that would pass a cap is refused, so a large
 * turn waits even while a smaller one still fits.
 *
 * Race window: the counters live in the judge cache store, and the Vercel
 * Runtime Cache has no atomic increment, so reserve and settle are unlocked
 * read-add-writes. Two landing within one round trip both read the same total
 * and one write is lost; a burst is bounded only by the Firewall's
 * per-address limits. The brake narrows the window to a round trip, not zero.
 *
 * Fail closed: an unreadable counter refuses uncached work. The Runtime Cache
 * client answers null for a failed read as for a missing key, so each scope
 * keeps a marker naming the counters it has written; a missing marker is
 * written and read back to prove the store answers, and a named counter that
 * still reads missing is treated as evicted. A memory-only Runtime Cache (no
 * endpoint) is refused outright. Write failures are silent in that client, so
 * lost writes go uncounted.
 */
import { cacheGetStrict, cacheSetStrict } from '../infra/cache';
import { REVIEW_LIMITS } from '../review/review';

/**
 * `get` resolves undefined or null for a missing key and may do the same for
 * a failed read; either method may throw when the store reports a failure.
 */
export interface SpendStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

/** US dollars per UTC hour and per UTC day. */
export interface SpendCaps {
  hourUsd: number;
  dayUsd: number;
}

export interface SpendRefusal {
  ok: false;
  /** `unavailable` when the counters could not be read at all. */
  window: 'hour' | 'day' | 'unavailable';
  spentUsd: number;
  capUsd: number;
  /** When the window resets, or for `unavailable`, when to try again. */
  resetsAt: Date;
}

export interface Hold {
  readonly reservedUsd: number;
  /**
   * Replaces the reservation with the actual cost; only the first call counts.
   * Never calling it (or passing a non-cost) keeps the full reservation.
   */
  settle(actualUsd: number): Promise<void>;
}

type Admission = { ok: true; hold: Hold } | SpendRefusal;

export interface SpendBrake {
  reserve(estimateUsd: number, now?: Date): Promise<Admission>;
}

/**
 * From https://ai-gateway.vercel.sh/v1/models (2026-09-18). Luna uses the
 * `pricing.regional.us` rates (10% above list) because the project runs in
 * iad1 and estimates should err high.
 */
const JEV_INPUT_USD_PER_TOKEN = 0.000_000_042;
const LUNA_INPUT_USD_PER_TOKEN = 0.000_000_44;
const LUNA_OUTPUT_USD_PER_TOKEN = 0.000_002_64;

/** Below English prose's ratio, so estimates from characters err high. */
const CHARS_PER_TOKEN = 3;

/** Generous allowance for the questions, path and note sent beside the code. */
const JEV_QUESTION_CHARS = 6000;

/** Post-change code and diff, each up to the per-file cap, plus the questions. */
const JEV_MAX_STATE_CHARS =
  2 * REVIEW_LIMITS.maxCharsPerFile + JEV_QUESTION_CHARS;

/**
 * Doubled because a stuck first attempt is retried once and may have been
 * billed too. Jev charges nothing for output.
 */
export const JEV_FILE_ESTIMATE_USD =
  2 * (JEV_MAX_STATE_CHARS / CHARS_PER_TOKEN) * JEV_INPUT_USD_PER_TOKEN;

export function lunaPartEstimateUsd(
  promptChars: number,
  maxOutputTokens: number,
): number {
  return (
    (promptChars / CHARS_PER_TOKEN) * LUNA_INPUT_USD_PER_TOKEN +
    maxOutputTokens * LUNA_OUTPUT_USD_PER_TOKEN
  );
}

/** Null for missing, non-numeric or zero costs. */
function reportedCost(cost: unknown): number | null {
  const n =
    typeof cost === 'string' || typeof cost === 'number'
      ? Number(cost)
      : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Falls back to token pricing when the gateway reports no cost or zero, so used tokens are never free. */
export function jevCostUsd(gatewayCost: unknown, inputTokens: number): number {
  return (
    reportedCost(gatewayCost) ??
    Math.max(0, inputTokens) * JEV_INPUT_USD_PER_TOKEN
  );
}

/** Same fallback as `jevCostUsd`. */
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

function httpStatusOf(err: unknown): number | undefined {
  let at: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && at; depth++) {
    const e = at as { statusCode?: unknown; responseHeaders?: unknown };
    // The gateway fabricates a 500 without headers for requests that never
    // got a response; only a status with headers is real.
    if (typeof e.statusCode === 'number' && e.responseHeaders) {
      return e.statusCode;
    }
    at = (at as { cause?: unknown }).cause;
  }
  return;
}

const MAX_CAUSE_DEPTH = 6;

const UNREACHED_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function neverReached(err: unknown): boolean {
  let at: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && at; depth++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === 'string' && UNREACHED_CODES.has(code)) {
      return true;
    }
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

const FIRST_CLIENT_ERROR = 400;
const FIRST_SERVER_ERROR = 500;

/**
 * Whether a failed call may have been billed for its prompt. Cancellations,
 * timeouts, 5xx and unexplained failures count; 4xx rejections and
 * connection failures do not.
 */
export function failureMayHaveBilled(
  err: unknown,
  cancelled: boolean,
): boolean {
  if (cancelled) {
    return true;
  }
  const status = httpStatusOf(err);
  if (status !== undefined) {
    return !(status >= FIRST_CLIENT_ERROR && status < FIRST_SERVER_ERROR);
  }
  return !neverReached(err);
}

export interface FailedCall {
  /** False when the signal had already aborted before sending. */
  sent: boolean;
  /** See `failureMayHaveBilled`. */
  mayHaveBilled: boolean;
  /** Answer plus reasoning characters received before it stopped. */
  outputChars: number;
}

export function lunaFailedCallUsd(promptChars: number, call: FailedCall) {
  if (!call.sent || (call.outputChars === 0 && !call.mayHaveBilled)) {
    return 0;
  }
  return (
    lunaPartEstimateUsd(promptChars, 0) +
    (Math.max(0, call.outputChars) / CHARS_PER_TOKEN) *
      LUNA_OUTPUT_USD_PER_TOKEN
  );
}

export function jevFailedCallUsd(stateChars: number, call: FailedCall) {
  if (!(call.sent && call.mayHaveBilled)) {
    return 0;
  }
  return (
    ((Math.max(0, stateChars) + JEV_QUESTION_CHARS) / CHARS_PER_TOKEN) *
    JEV_INPUT_USD_PER_TOKEN
  );
}

const MS_PER_HOUR = 3_600_000;
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;

const UNREADABLE_RETRY_MS = 60_000;

/**
 * Absorbs floating-point dust: a settlement this close to the reservation is
 * skipped, and a reservation filling a cap exactly still fits.
 */
const EPSILON_USD = 1e-9;

/** Twice the window, so a settle just after the window ends still finds its key. */
const HOUR_KEY_TTL_SECONDS = 2 * SECONDS_PER_HOUR;
const DAY_KEY_TTL_SECONDS = 2 * HOURS_PER_DAY * SECONDS_PER_HOUR;

/** ISO prefixes: `2026-09-18T14` and `2026-09-18`. */
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

const cacheStore: SpendStore = {
  get: (key) => cacheGetStrict(key),
  set: (key, value, ttl) => cacheSetStrict(key, value, 'model-spend', ttl),
};

type Trouble = 'read' | 'write' | 'lost';
const logged = new Set<Trouble>();

const TROUBLE: Record<Trouble, string> = {
  lost: 'lost a counter it had written, and counts it from zero',
  read: 'could not be read, so uncached model work is refused until it can be',
  write: 'could not be written, so work goes uncounted until it can be',
};

function logOnce(kind: Trouble, scope: string, err: unknown): void {
  if (logged.has(kind)) {
    return;
  }
  logged.add(kind);
  const cause = err instanceof Error ? err.message : String(err);
  console.error(
    `[spend] The ${scope} spend counter ${TROUBLE[kind]} (${cause}). Logged once per instance.`,
  );
}

/** `amountOf` also accepts a bare number, the legacy stored shape. */
interface Counter {
  usd: number;
  v: 1;
}

/** Marker naming the hour and day counter keys this scope has written. */
interface Written {
  v: 1;
  hour: string | null;
  day: string | null;
}

function amountOf(value: unknown): number | undefined {
  const usd =
    typeof value === 'number' ? value : (value as Counter | null)?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) ? usd : undefined;
}

function writtenOf(value: unknown): Written | null {
  const w = value as Partial<Written> | null | undefined;
  return w && typeof w === 'object' && w.v === 1
    ? { day: w.day ?? null, hour: w.hour ?? null, v: 1 }
    : null;
}

const counter = (usd: number): Counter => ({ usd: Math.max(0, usd), v: 1 });

class Unreadable extends Error {}

interface CounterSnapshot {
  written: Written | null;
  hour: number | undefined;
  hourKey: string;
  day: number | undefined;
  dayKey: string;
}

const lostCounter = (r: CounterSnapshot) =>
  (r.hour === undefined && r.written?.hour === r.hourKey) ||
  (r.day === undefined && r.written?.day === r.dayKey);

/** Scopes (e.g. `mcp`) never count against each other. */
export function createSpendBrake(
  scope: string,
  caps: SpendCaps,
  store: SpendStore = cacheStore,
): SpendBrake {
  const writtenKey = `spend:${scope}:written`;

  async function readOnce(
    hourKey: string,
    dayKey: string,
  ): Promise<CounterSnapshot> {
    const [written, hour, day] = await Promise.all([
      store.get(writtenKey).then(writtenOf),
      store.get(hourKey).then(amountOf),
      store.get(dayKey).then(amountOf),
    ]);
    return { day, dayKey, hour, hourKey, written };
  }

  /** Proves the store answers by writing the marker and reading it back. */
  async function probe(read: CounterSnapshot): Promise<void> {
    await store.set(
      writtenKey,
      {
        day: read.day === undefined ? null : read.dayKey,
        hour: read.hour === undefined ? null : read.hourKey,
        v: 1,
      } satisfies Written,
      DAY_KEY_TTL_SECONDS,
    );
    if (writtenOf(await store.get(writtenKey)) === null) {
      throw new Unreadable(`${writtenKey} could not be read back`);
    }
  }

  /** A missing counter counts as zero only after the store has proven it answers. */
  async function readCounters(
    hourKey: string,
    dayKey: string,
  ): Promise<[number, number]> {
    let read = await readOnce(hourKey, dayKey);
    if (read.written === null) {
      await probe(read);
      // A timed-out batch returns null for every key, so re-read now that the
      // store has proven it answers rather than count from zero.
      read = await readOnce(hourKey, dayKey);
      if (read.written === null) {
        throw new Unreadable(
          `${writtenKey} read as missing after it was written`,
        );
      }
    } else if (lostCounter(read)) {
      read = await readOnce(hourKey, dayKey);
      if (read.written === null) {
        throw new Unreadable(`${writtenKey} read as missing`);
      }
      if (lostCounter(read)) {
        logOnce('lost', scope, `${hourKey} or ${dayKey}`);
      }
    }
    return [read.hour ?? 0, read.day ?? 0];
  }

  /** `usd` may be negative. Logs rather than throws. */
  async function charge(hourKey: string, dayKey: string, usd: number) {
    let hour: number;
    let day: number;
    try {
      [hour, day] = await readCounters(hourKey, dayKey);
    } catch (err) {
      // Writing a sum from an unknown base would clobber the real total.
      logOnce('read', scope, err);
      return;
    }
    try {
      await Promise.all([
        store.set(hourKey, counter(hour + usd), HOUR_KEY_TTL_SECONDS),
        store.set(dayKey, counter(day + usd), DAY_KEY_TTL_SECONDS),
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
        if (!(Number.isFinite(actualUsd) && actualUsd >= 0)) {
          return;
        }
        const delta = actualUsd - reservedUsd;
        if (Math.abs(delta) > EPSILON_USD) {
          // Into the reservation's windows, even if the hour has turned.
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
      // No read, no refusal; a surprise cost (e.g. a cache entry expiring
      // in between) is still settled.
      if (reserved === 0) {
        return { hold: holdFor(hourKey, dayKey, 0), ok: true };
      }
      let hour: number;
      let day: number;
      try {
        [hour, day] = await readCounters(hourKey, dayKey);
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
      // Day first: when both are spent, the later reset is the true one.
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
      // Written from the values just read, not re-read, to keep the race
      // window short. Marker after counters, so a marker implies its counters.
      try {
        await Promise.all([
          store.set(hourKey, counter(hour + reserved), HOUR_KEY_TTL_SECONDS),
          store.set(dayKey, counter(day + reserved), DAY_KEY_TTL_SECONDS),
        ]);
        await store.set(
          writtenKey,
          { day: dayKey, hour: hourKey, v: 1 } satisfies Written,
          DAY_KEY_TTL_SECONDS,
        );
      } catch (err) {
        logOnce('write', scope, err);
      }
      return { hold: holdFor(hourKey, dayKey, reserved), ok: true };
    },
  };
}
