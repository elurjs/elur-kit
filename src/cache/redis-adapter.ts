// --- Redis / Upstash / Cloudflare KV Cache Adapter (v2.1 — Fix #3) ---
//
// Pluggable cache adapter for serverless and distributed deployments.
// Implements the same CacheAdapter interface as the filesystem adapter, so
// it can be dropped in via config without changing application code.
//
// Supports any Redis-compatible client (node-redis, ioredis, Upstash REST,
// Cloudflare KV via @upstash/redis or direct API).

import type { CacheAdapter, CacheEntry, CacheWriteOptions } from "./adapter.js";

// ─── Redis Cache Adapter ────────────────────────────────────────────────────

export interface RedisCacheAdapterOptions {
  /**
   * Redis client with get/set/del commands.
   * Compatible with node-redis, ioredis, and Upstash.
   */
  client: RedisClient;
  /** Key prefix to namespace cache entries. Default: "elur-kit:". */
  prefix?: string;
}

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { EX?: number; PX?: number; NX?: boolean }): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  srem?(key: string, ...members: string[]): Promise<number>;
  smembers?(key: string): Promise<string[]>;
  sadd?(key: string, ...members: string[]): Promise<number>;
}

export function createRedisCacheAdapter(options: RedisCacheAdapterOptions): CacheAdapter {
  const client = options.client;
  const prefix = options.prefix ?? "elur-kit:";

  const dataKey = (key: string) => `${prefix}data:${key}`;
  const tagKey = (tag: string) => `${prefix}tag:${tag}`;

  async function get(key: string): Promise<CacheEntry | null> {
    const raw = await client.get(dataKey(key));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CacheEntry;
    } catch {
      return null;
    }
  }

  async function set(key: string, value: CacheEntry, opts: CacheWriteOptions): Promise<void> {
    const entry: CacheEntry = {
      html: value.html,
      generatedAt: value.generatedAt ?? Date.now(),
      revalidate: opts.revalidate,
      tags: opts.tags,
      version: opts.version,
    };
    const fullKey = dataKey(key);
    const serialized = JSON.stringify(entry);

    // Set TTL on the Redis key if revalidate is set (convert seconds to ms for PX).
    if (opts.revalidate > 0) {
      await client.set(fullKey, serialized, { PX: opts.revalidate * 1000 });
    } else {
      await client.set(fullKey, serialized);
    }

    // Update tag index using Redis sets if available.
    if (opts.tags && opts.tags.length > 0 && client.sadd && client.srem) {
      for (const tag of opts.tags) {
        await client.sadd(tagKey(tag), fullKey);
      }
    }
  }

  async function del(key: string): Promise<void> {
    await client.del(dataKey(key));
  }

  async function invalidateTags(tags: readonly string[]): Promise<void> {
    if (tags.length === 0) return;

    if (client.smembers && client.srem) {
      // Use Redis sets for O(1) tag lookup.
      const keysToDelete = new Set<string>();
      for (const tag of tags) {
        const members = await client.smembers(tagKey(tag));
        for (const m of members) keysToDelete.add(m);
        await client.del(tagKey(tag));
      }
      if (keysToDelete.size > 0) {
        await client.del([...keysToDelete]);
      }
    } else {
      // Fallback: scan all data keys and check tags in the entry.
      const allKeys = await client.keys(`${prefix}data:*`);
      for (const fullKey of allKeys) {
        const raw = await client.get(fullKey);
        if (!raw) continue;
        try {
          const entry = JSON.parse(raw) as CacheEntry;
          if (entry.tags?.some((t) => tags.includes(t))) {
            await client.del(fullKey);
          }
        } catch {
          // skip corrupt entries
        }
      }
    }
  }

  return { get, set, delete: del, invalidateTags };
}

// ─── Cloudflare KV Cache Adapter ────────────────────────────────────────────

export interface CloudflareKVAdapterOptions {
  /**
   * Cloudflare KV namespace binding (from wrangler.toml env binding).
   * Must implement `get`, `put`, and `delete` methods.
   */
  namespace: CloudflareKVNamespace;
  /** Key prefix to namespace cache entries. Default: "elur-kit:". */
  prefix?: string;
}

export interface CloudflareKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ keys: { name: string; metadata?: unknown }[] }>;
}

export function createCloudflareKVCacheAdapter(options: CloudflareKVAdapterOptions): CacheAdapter {
  const kv = options.namespace;
  const prefix = options.prefix ?? "elur-kit:";

  const dataKey = (key: string) => `${prefix}data:${key}`;
  const tagKey = (tag: string) => `${prefix}tag:${tag}`;

  // KV doesn't have sets, so we store tag → keys as a JSON string.
  async function loadTagKeys(tag: string): Promise<string[]> {
    const raw = await kv.get(tagKey(tag));
    if (!raw) return [];
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  async function saveTagKeys(tag: string, keys: string[]): Promise<void> {
    await kv.put(tagKey(tag), JSON.stringify(keys));
  }

  async function get(key: string): Promise<CacheEntry | null> {
    const raw = await kv.get(dataKey(key));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CacheEntry;
    } catch {
      return null;
    }
  }

  async function set(key: string, value: CacheEntry, opts: CacheWriteOptions): Promise<void> {
    const entry: CacheEntry = {
      html: value.html,
      generatedAt: value.generatedAt ?? Date.now(),
      revalidate: opts.revalidate,
      tags: opts.tags,
      version: opts.version,
    };
    const fullKey = dataKey(key);
    const serialized = JSON.stringify(entry);

    // KV supports expirationTtl in seconds.
    if (opts.revalidate > 0) {
      await kv.put(fullKey, serialized, { expirationTtl: opts.revalidate });
    } else {
      await kv.put(fullKey, serialized);
    }

    // Update tag index.
    if (opts.tags && opts.tags.length > 0) {
      for (const tag of opts.tags) {
        const existing = await loadTagKeys(tag);
        if (!existing.includes(fullKey)) {
          existing.push(fullKey);
          await saveTagKeys(tag, existing);
        }
      }
    }
  }

  async function del(key: string): Promise<void> {
    await kv.delete(dataKey(key));
  }

  async function invalidateTags(tags: readonly string[]): Promise<void> {
    if (tags.length === 0) return;
    for (const tag of tags) {
      const keys = await loadTagKeys(tag);
      for (const fullKey of keys) {
        await kv.delete(fullKey);
      }
      await kv.delete(tagKey(tag));
    }
  }

  return { get, set, delete: del, invalidateTags };
}
