/**
 * Vercel Runtime Cache on a deploy (per region, shared across instances,
 * survives deploys); process memory elsewhere. Jev is deterministic enough
 * that re-judging identical input is pure waste.
 */
import { createHash } from 'node:crypto';

const CACHE_TTL_SECONDS = 3_600;

const MS_PER_SECOND = 1_000;

const MAX_MEMORY_ENTRIES = 5_000;

const KEY_DIGEST_CHARS = 40;

/**
 * The Runtime Cache's item limit. An oversized `set` fails silently, so
 * callers with large values pass `sizeOf` and oversized values are not
 * stored. Applied to the memory fallback too, so local runs match deploys.
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
 * Mirrors the backend selection in `getCache` of `@vercel/functions` 3.9.8
 * (`cache/index.js`), which silently falls back to per-instance memory with
 * only a console warning. Checked per call because the request context is
 * per request.
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

let runtimeClient: Promise<CacheLike | null> | null = null;

/** Null when `@vercel/functions` could not be loaded. */
function runtimeOf(): Promise<CacheLike | null> {
  runtimeClient ??= (async () => {
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

  return runtimeClient;
}

/**
 * `shared: false` on Vercel means per-instance memory: fine for judgments,
 * which only repeat work, wrong for spend counters every instance must see.
 */
async function backendOf(): Promise<{ store: CacheLike; shared: boolean }> {
  if (!process.env.VERCEL) {
    // Off Vercel there is one process, so its memory is the whole store.
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

class CacheUnavailableError extends Error {}

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
 * Throws when there is no shared store or it throws. Undefined does not prove
 * a missing key: the Runtime Cache client swallows 5xx, network errors and
 * its 500 ms timeout and answers null. See `../spend/spend.ts` for telling
 * them apart.
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

/** Throws when there is no shared store, but the client swallows failed writes, so no throw does not prove it landed. */
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

export function cacheKey(kind: string, input: unknown): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, KEY_DIGEST_CHARS)}`;
}

/**
 * `ttl` is in seconds. `sizeOf` returns stored bytes; omit it only when the
 * value cannot approach `MAX_ITEM_BYTES`.
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
    // A cache failure must never fail judging.
  }
  const value = await compute();

  if (!sizeOf || sizeOf(value) <= MAX_ITEM_BYTES) {
    try {
      await store.set(key, value, { name, ttl });
    } catch {
      // Same.
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

/** `ttl` is in seconds. */
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
