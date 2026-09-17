/**
 * A one-hour cache for judgments and reviews keyed by what was judged. On
 * Vercel this is the Runtime Cache (per region, shared across function
 * instances, survives deploys); anywhere else it is this process's memory.
 * Same code (and same question set) in, same answers out — Jev is
 * deterministic enough that a repeat is pure waste.
 */
import { createHash } from "node:crypto";

export const CACHE_TTL_SECONDS = 60 * 60;

interface CacheLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options?: { ttl?: number; name?: string; tags?: string[] }): Promise<void>;
}

const memory = new Map<string, { value: unknown; expires: number }>();
const memoryCache: CacheLike = {
  async get(key) {
    const hit = memory.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      memory.delete(key);
      return undefined;
    }
    return hit.value;
  },
  async set(key, value, options) {
    if (memory.size > 5_000) memory.clear();
    memory.set(key, { value, expires: Date.now() + (options?.ttl ?? CACHE_TTL_SECONDS) * 1_000 });
  },
};

let backend: Promise<CacheLike> | null = null;

function cache(): Promise<CacheLike> {
  backend ??= (async () => {
    if (!process.env.VERCEL) return memoryCache;
    try {
      const { getCache } = await import("@vercel/functions");
      const runtime = getCache({ namespace: "clean-code-judge" });
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
  return `${kind}:${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40)}`;
}

/** Read through: return the cached value or compute, store and return it. Reports whether it was a hit. */
export async function cached<T>(key: string, name: string, compute: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  const store = await cache();
  try {
    const hit = await store.get(key);
    if (hit !== undefined && hit !== null) return { value: hit as T, hit: true };
  } catch {
    /* a cache failure is never a judging failure */
  }
  const value = await compute();
  try {
    await store.set(key, value, { ttl: CACHE_TTL_SECONDS, name });
  } catch {
    /* same */
  }
  return { value, hit: false };
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const v = await (await cache()).get(key);
    return v === null ? undefined : (v as T | undefined);
  } catch {
    return undefined;
  }
}

export async function cacheSet(key: string, value: unknown, name: string): Promise<void> {
  try {
    await (await cache()).set(key, value, { ttl: CACHE_TTL_SECONDS, name });
  } catch {
    /* ignore */
  }
}
