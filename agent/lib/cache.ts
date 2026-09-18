/**
 * A one-hour cache for judgments and reviews keyed by what was judged. On
 * Vercel this is the Runtime Cache (per region, shared across function
 * instances, survives deploys); anywhere else it is this process's memory.
 * Same code (and same question set) in, same answers out — Jev is
 * deterministic enough that a repeat is pure waste.
 */
import { createHash } from 'node:crypto';

/** One hour, in seconds. */
const CACHE_TTL_SECONDS = 3_600;

/** Seconds are what the cache is configured in; milliseconds are what it stores. */
const MS_PER_SECOND = 1_000;

/** How many entries the in-memory fallback holds before it is emptied. */
const MAX_MEMORY_ENTRIES = 5_000;

/** How much of the digest names a key: enough that a collision is unthinkable. */
const KEY_DIGEST_CHARS = 40;

/**
 * What one item may hold: the Runtime Cache's own limit, two megabytes.
 * A `set` past it fails where nobody is listening — the catch below is the
 * only thing that hears it — so a caller whose value can be that big says how
 * big this one is, and an oversized value is computed, returned and not
 * stored. The memory fallback holds to the same limit rather than to none, so
 * that a deploy and a laptop skip the same values.
 */
const MAX_ITEM_BYTES = 2_000_000;

interface CacheLike {
  get(key: string): Promise<unknown>;
  set(
    key: string,
    value: unknown,
    options?: { ttl?: number; name?: string; tags?: string[] },
  ): Promise<void>;
}

const memory = new Map<string, { value: unknown; expires: number }>();
const memoryCache: CacheLike = {
  async get(key) {
    const hit = memory.get(key);
    if (!hit) {
      return;
    }
    if (hit.expires < Date.now()) {
      memory.delete(key);
      return;
    }
    return hit.value;
  },
  async set(key, value, options) {
    if (memory.size > MAX_MEMORY_ENTRIES) {
      memory.clear();
    }
    memory.set(key, {
      expires: Date.now() + (options?.ttl ?? CACHE_TTL_SECONDS) * MS_PER_SECOND,
      value,
    });
  },
};

/**
 * Where the Runtime Cache client sends a call, mirroring `getCache` in
 * `@vercel/functions` 3.9.8 (`cache/index.js`): the request context's own
 * cache when the platform put one there, the cache endpoint when both of its
 * variables are set and parse, and otherwise a memory of this instance's own,
 * with nothing more than one console warning. Asked on every strict call,
 * because the request context is per request.
 */
function runtimeCacheIsShared(): boolean {
  const context = (
    globalThis as {
      [key: symbol]: { get?: () => { cache?: unknown } } | undefined;
    }
  )[Symbol.for('@vercel/request-context')]?.get?.();
  if (context?.cache) {
    return true;
  }
  const { RUNTIME_CACHE_ENDPOINT, RUNTIME_CACHE_HEADERS } = process.env;
  if (
    process.env.RUNTIME_CACHE_DISABLE_BUILD_CACHE === 'true' ||
    !RUNTIME_CACHE_ENDPOINT ||
    !RUNTIME_CACHE_HEADERS
  ) {
    return false;
  }
  try {
    JSON.parse(RUNTIME_CACHE_HEADERS);
    return true;
  } catch {
    return false;
  }
}

/**
 * The store, and whether it is the one it should be. On Vercel a store that
 * is really this instance's memory is `shared: false`: fine for a judgment
 * cache, which only repeats work, and wrong for a counter every instance
 * must see (`./spend.ts`).
 */
let backend: Promise<CacheLike | null> | null = null;

/** The Runtime Cache client, or null when it could not be loaded. */
function runtimeOf(): Promise<CacheLike | null> {
  backend ??= (async () => {
    try {
      const { getCache } = await import('@vercel/functions');
      const runtime = getCache({ namespace: 'clean-code-judge' });
      return {
        get: (key) => runtime.get(key),
        set: (key, value, options) => runtime.set(key, value, options),
      };
    } catch {
      return null;
    }
  })();
  return backend;
}

async function backendOf(): Promise<{ store: CacheLike; shared: boolean }> {
  if (!process.env.VERCEL) {
    // Off Vercel there is one process, and its memory is the whole store.
    return { shared: true, store: memoryCache };
  }
  const runtime = await runtimeOf();
  return runtime
    ? { shared: runtimeCacheIsShared(), store: runtime }
    : { shared: false, store: memoryCache };
}

async function cache(): Promise<CacheLike> {
  return (await backendOf()).store;
}

/** Why a strict read or write did not happen: the store threw, or it is not the shared one. */
class CacheUnavailableError extends Error {}

/** The shared store, or a `CacheUnavailableError` when this instance only has its own memory. */
async function sharedCache(): Promise<CacheLike> {
  const { store, shared } = await backendOf();
  if (!shared) {
    throw new CacheUnavailableError(
      'the Runtime Cache is not configured here (no request-context cache and no RUNTIME_CACHE_ENDPOINT), so this instance only has its own memory',
    );
  }
  return store;
}

/**
 * Read a key from the shared store: undefined when it is not there, and a
 * throw when this instance has no shared store or the store threw.
 *
 * Undefined is not proof of a missing key. The Runtime Cache client catches
 * every failed read, a 5xx, a network error or its own 500 ms timeout, logs
 * it and answers null, exactly as it answers for a key that is not there. A
 * caller that must tell the two apart has to do it itself, as `./spend.ts`
 * does with a key it knows is present.
 */
export async function cacheGetStrict(key: string): Promise<unknown> {
  const store = await sharedCache();
  try {
    const value = await store.get(key);
    return value === null ? undefined : value;
  } catch (err) {
    throw new CacheUnavailableError(`reading ${key} failed`, { cause: err });
  }
}

/**
 * Write a key to the shared store, and throw when this instance has none or
 * the store threw. As with a read, the Runtime Cache client catches a failed
 * write itself, so no throw is no proof that it landed.
 */
export async function cacheSetStrict(
  key: string,
  value: unknown,
  name: string,
  ttl: number,
): Promise<void> {
  const store = await sharedCache();
  try {
    await store.set(key, value, { name, ttl });
  } catch (err) {
    throw new CacheUnavailableError(`writing ${key} failed`, { cause: err });
  }
}

/** A stable key for any JSON-serialisable description of the work. */
export function cacheKey(kind: string, input: unknown): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, KEY_DIGEST_CHARS)}`;
}

/**
 * Read through: return the cached value or compute, store and return it.
 * Reports whether it was a hit. `ttl` is in seconds, and is the hour above
 * unless the caller has a reason for a shorter one — a pull request moves
 * while a judgment of fixed text does not. `sizeOf` measures a value the
 * store might refuse, in the bytes it would be stored as; without it every
 * value is assumed to fit, which is true of everything but a diff.
 */
export async function cached<T>(
  key: string,
  name: string,
  compute: () => Promise<T>,
  ttl = CACHE_TTL_SECONDS,
  sizeOf?: (value: T) => number,
): Promise<{ value: T; hit: boolean }> {
  const store = await cache();
  try {
    const hit = await store.get(key);
    if (hit !== undefined && hit !== null) {
      return { hit: true, value: hit as T };
    }
  } catch {
    /* a cache failure is never a judging failure */
  }
  const value = await compute();
  if (!sizeOf || sizeOf(value) <= MAX_ITEM_BYTES) {
    try {
      await store.set(key, value, { name, ttl });
    } catch {
      /* same */
    }
  }
  return { hit: false, value };
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const v = await (await cache()).get(key);
    return v === null ? undefined : (v as T | undefined);
  } catch {
    return;
  }
}

/** Store a value for the hour above, or for `ttl` seconds when a caller needs longer. */
export async function cacheSet(
  key: string,
  value: unknown,
  name: string,
  ttl = CACHE_TTL_SECONDS,
): Promise<void> {
  try {
    await (await cache()).set(key, value, { name, ttl });
  } catch {
    /* ignore */
  }
}
