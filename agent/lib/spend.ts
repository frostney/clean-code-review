/**
 * A spend brake shared by every caller of one scope: what the models cost,
 * counted per clock hour and per UTC day, and a yes or no on whether new model
 * work may start.
 *
 * Work reserves before it starts and settles when it stops. A caller works
 * out what it is about to do that the cache cannot answer, prices that at a
 * conservative estimate (`JEV_FILE_ESTIMATE_USD` per file Jev has to judge,
 * `lunaPartEstimateUsd` per review part Luna has to write), and asks
 * `reserve` for it. The estimate is added to the counters before any model
 * runs, so the next caller sees it at once, and is then replaced by what the
 * work plausibly cost once it stops: what a finished call reported, and for a
 * call that failed or was cancelled, what it can have used (`failedCallUsd`),
 * which is nothing for a call that was never sent or was turned away. The
 * reservation is the worst case and only stops a burst before it starts;
 * settling at the worst case would let cancelled work lock the page. Work
 * that needs no model reserves nothing and is never refused.
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
 * reads a failure as zero is no brake. The Runtime Cache client never says a
 * read failed (it answers null, as for a missing key; see `./cache.ts`), so a
 * scope also keeps a marker naming the counters it has written. A missing
 * marker is written and read back, and a store that cannot return it is not
 * answering. A counter the marker names that reads as missing is read once
 * more, and while the marker still reads it is taken to have been evicted and
 * counts from zero. A Runtime Cache that is really this instance's memory
 * (no endpoint configured) is refused outright. Write failures are silent in
 * that client, so work whose counter write was lost simply goes uncounted.
 * Failures are logged once per instance so they show in the function logs.
 */
import { cacheGetStrict, cacheSetStrict } from './cache';
import { REVIEW_LIMITS } from './review';

/**
 * Where the counters are read and written. Injected by a test; the shared
 * cache otherwise. `get` resolves undefined or null for a missing key, and
 * may resolve the same for a read that failed; either may throw when the
 * store says it failed.
 */
export interface SpendStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
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
   * Replace the reservation with what the work plausibly cost. Called once; a
   * later call does nothing. A caller that cannot say at all (a fault of this
   * code, not of a model call) does not call it, and keeps the reservation.
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

/** The HTTP status a failed call got back, looking through wrapped causes, or undefined when none came back. */
function httpStatusOf(err: unknown): number | undefined {
  let at: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && at; depth++) {
    const e = at as { statusCode?: unknown; responseHeaders?: unknown };
    // A status with response headers is a response; the gateway also makes
    // up a 500 for a request that never got one, and that has no headers.
    if (typeof e.statusCode === 'number' && e.responseHeaders) {
      return e.statusCode;
    }
    at = (at as { cause?: unknown }).cause;
  }
  return;
}

/** How far down a chain of `cause`s to look. */
const MAX_CAUSE_DEPTH = 6;

/** Connection failures: the request never reached anything that could run it. */
const UNREACHED_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** True when a failed call never reached a server: a refused connection, an unknown host. */
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

const CLIENT_ERROR = 400;
const SERVER_ERROR = 500;

/**
 * Whether a call that failed after it was sent can have had its prompt read:
 * true when it was cancelled or timed out on the way (the model may be
 * reading it), and for a server error or a failure that says nothing; false
 * when it was turned away with a 4xx (a bad key, a rate limit) or never
 * reached a server at all.
 */
export function failureWasProcessed(err: unknown, cancelled: boolean): boolean {
  if (cancelled) {
    return true;
  }
  const status = httpStatusOf(err);
  if (status !== undefined) {
    return !(status >= CLIENT_ERROR && status < SERVER_ERROR);
  }
  return !neverReached(err);
}

/** What happened to a model call that did not report its cost. */
export interface FailedCall {
  /** False when the call was never made, because its signal had already aborted. */
  sent: boolean;
  /** Whether its prompt can have been read: `failureWasProcessed`. */
  processed: boolean;
  /** Characters of output, answer and reasoning, received before it stopped. */
  outputChars: number;
}

/**
 * What a Luna call that failed or was cancelled plausibly cost: nothing when
 * it was never sent, or turned away before it wrote anything; otherwise its
 * prompt, and whatever it had written, at three characters a token.
 */
export function lunaFailedCallUsd(promptChars: number, call: FailedCall) {
  if (!call.sent || (call.outputChars === 0 && !call.processed)) {
    return 0;
  }
  return (
    lunaPartEstimateUsd(promptChars, 0) +
    (Math.max(0, call.outputChars) / CHARS_PER_TOKEN) *
      LUNA_OUTPUT_USD_PER_TOKEN
  );
}

/**
 * What a Jev call that failed or was cancelled plausibly cost: its input,
 * `stateChars` of state and the questions, unless it was never sent or was
 * turned away. Jev charges nothing for output.
 */
export function jevFailedCallUsd(stateChars: number, call: FailedCall) {
  if (!(call.sent && call.processed)) {
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

/** Each kind of store trouble, logged once per instance. */
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

/** What a counter holds. A bare number is the shape counters had before, read the same. */
interface Counter {
  usd: number;
  v: 1;
}

/** Which counters of a scope have been written: the current hour's and day's, by key. */
interface Written {
  v: 1;
  hour: string | null;
  day: string | null;
}

/** A stored amount, or undefined when the key is missing (or the read failed). */
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

/** The counters could not be read, and nobody knows what they hold. */
class Unreadable extends Error {}

/** One read of a scope's marker and of the two counters a turn is counted in. */
interface Read {
  written: Written | null;
  hour: number | undefined;
  hourKey: string;
  day: number | undefined;
  dayKey: string;
}

/** A counter the marker says was written reads as missing. */
const lostCounter = (r: Read) =>
  (r.hour === undefined && r.written?.hour === r.hourKey) ||
  (r.day === undefined && r.written?.day === r.dayKey);

/** A brake for one scope, such as `mcp`. Separate scopes never count against each other. */
export function createSpendBrake(
  scope: string,
  caps: SpendCaps,
  store: SpendStore = cacheStore,
): SpendBrake {
  const writtenKey = `spend:${scope}:written`;

  async function readOnce(hourKey: string, dayKey: string): Promise<Read> {
    const [written, hour, day] = await Promise.all([
      store.get(writtenKey).then(writtenOf),
      store.get(hourKey).then(amountOf),
      store.get(dayKey).then(amountOf),
    ]);
    return { day, dayKey, hour, hourKey, written };
  }

  /**
   * No marker: never written, expired, evicted, or the store is not
   * answering. Write one and read it back; a store that cannot return it is
   * not answering.
   */
  async function probe(read: Read): Promise<void> {
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

  /**
   * The two counters, or `Unreadable` when the store is not answering. A
   * missing counter is zero only once the store has shown it can answer:
   * by returning the marker, or by returning one just written.
   */
  async function readCounters(
    hourKey: string,
    dayKey: string,
  ): Promise<[number, number]> {
    let read = await readOnce(hourKey, dayKey);
    if (read.written === null) {
      await probe(read);
      // The first batch may have failed as a whole, a timeout returning null
      // for every key, so its missing counters say nothing. Now that the store
      // has shown it answers, read them again rather than count from zero.
      read = await readOnce(hourKey, dayKey);
      if (read.written === null) {
        throw new Unreadable(
          `${writtenKey} read as missing after it was written`,
        );
      }
    } else if (lostCounter(read)) {
      // A counter this scope wrote reads as missing: ask once more.
      read = await readOnce(hourKey, dayKey);
      if (read.written === null) {
        throw new Unreadable(`${writtenKey} read as missing`);
      }
      if (lostCounter(read)) {
        // The store answers, and still has no such counter: it was evicted.
        logOnce('lost', scope, `${hourKey} or ${dayKey}`);
      }
    }
    return [read.hour ?? 0, read.day ?? 0];
  }

  /** Add `usd`, which may be negative, to both windows a reservation was made in; log a failure rather than throw it. */
  async function charge(hourKey: string, dayKey: string, usd: number) {
    let hour: number;
    let day: number;
    try {
      [hour, day] = await readCounters(hourKey, dayKey);
    } catch (err) {
      // Writing a sum from an unreadable counter would overwrite what it holds.
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
      // The marker is written after the counters, so a reader that finds it
      // naming a counter can expect that counter to be there.
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
