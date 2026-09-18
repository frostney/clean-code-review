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

let backend: Promise<CacheLike> | null = null;

function cache(): Promise<CacheLike> {
  backend ??= (async () => {
    if (!process.env.VERCEL) {
      return memoryCache;
    }
    try {
      const { getCache } = await import('@vercel/functions');
      const runtime = getCache({ namespace: 'clean-code-judge' });
      return {
        get: (key) => runtime.get(key),
        set: (key, value, options) => runtime.set(key, value, options),
      };
    } catch {
      return memoryCache;
    }
  })();
  return backend;
}

/** A stable key for any JSON-serialisable description of the work. */
export function cacheKey(kind: string, input: unknown): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, KEY_DIGEST_CHARS)}`;
}

/**
 * Read through: return the cached value or compute, store and return it.
 * Reports whether it was a hit. `ttl` is in seconds, and is the hour above
 * unless the caller has a reason for a shorter one — a pull request moves
 * while a judgment of fixed text does not.
 */
export async function cached<T>(
  key: string,
  name: string,
  compute: () => Promise<T>,
  ttl = CACHE_TTL_SECONDS,
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
  try {
    await store.set(key, value, { name, ttl });
  } catch {
    /* same */
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

export async function cacheSet(
  key: string,
  value: unknown,
  name: string,
): Promise<void> {
  try {
    await (await cache()).set(key, value, { name, ttl: CACHE_TTL_SECONDS });
  } catch {
    /* ignore */
  }
}
