import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRedisCacheAdapter,
  createCloudflareKVCacheAdapter,
  type RedisClient,
  type CloudflareKVNamespace,
} from "../src/cache/redis-adapter.ts";
import { cacheKey } from "../src/cache/adapter.ts";

// Fix #3: Redis / Upstash / Cloudflare KV Cache Adapter

// In-memory mock Redis client for testing.
function createMockRedis(): RedisClient {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    async get(key) { return store.get(key) ?? null; },
    async set(key, value, opts) {
      store.set(key, value);
      // Note: mock doesn't implement TTL expiry, just stores the value.
      return "OK";
    },
    async del(key) {
      const keys = Array.isArray(key) ? key : [key];
      let count = 0;
      for (const k of keys) { if (store.delete(k)) count++; }
      return count;
    },
    async keys(pattern) {
      // Simple prefix matching (not full glob).
      const prefix = pattern.replace(/\*$/, "");
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    async sadd(key, ...members) {
      if (!sets.has(key)) sets.set(key, new Set());
      for (const m of members) sets.get(key)!.add(m);
      return members.length;
    },
    async srem(key, ...members) {
      const set = sets.get(key);
      if (!set) return 0;
      let count = 0;
      for (const m of members) if (set.delete(m)) count++;
      return count;
    },
    async smembers(key) {
      const set = sets.get(key);
      return set ? [...set] : [];
    },
  };
}

describe("Fix #3: Redis Cache Adapter", () => {
  it("sets and gets a cache entry", async () => {
    const redis = createMockRedis();
    const adapter = createRedisCacheAdapter({ client: redis });
    const key = cacheKey("/page1");
    await adapter.set(key, { html: "<h1>Hello</h1>", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60 });
    const entry = await adapter.get(key);
    assert.ok(entry, "should return the entry");
    assert.equal(entry!.html, "<h1>Hello</h1>");
    assert.equal(entry!.revalidate, 60);
  });

  it("returns null for missing keys", async () => {
    const redis = createMockRedis();
    const adapter = createRedisCacheAdapter({ client: redis });
    const entry = await adapter.get(cacheKey("/nonexistent"));
    assert.equal(entry, null);
  });

  it("deletes entries", async () => {
    const redis = createMockRedis();
    const adapter = createRedisCacheAdapter({ client: redis });
    const key = cacheKey("/delete-me");
    await adapter.set(key, { html: "temp", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60 });
    await adapter.delete(key);
    const entry = await adapter.get(key);
    assert.equal(entry, null);
  });

  it("invalidates by tag using Redis sets", async () => {
    const redis = createMockRedis();
    const adapter = createRedisCacheAdapter({ client: redis });
    const key1 = cacheKey("/page1");
    const key2 = cacheKey("/page2");
    await adapter.set(key1, { html: "a", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60, tags: ["posts"] });
    await adapter.set(key2, { html: "b", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60, tags: ["posts"] });
    await adapter.invalidateTags(["posts"]);
    assert.equal(await adapter.get(key1), null, "key1 invalidated by tag");
    assert.equal(await adapter.get(key2), null, "key2 invalidated by tag");
  });

  it("uses key prefix for namespacing", async () => {
    const redis = createMockRedis();
    const adapter = createRedisCacheAdapter({ client: redis, prefix: "myapp:" });
    const key = cacheKey("/page");
    await adapter.set(key, { html: "x", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60 });
    // Verify the key was stored with the prefix.
    const redisKey = `myapp:data:${key}`;
    const raw = await redis.get(redisKey);
    assert.ok(raw, "entry stored with prefix");
  });
});

// ─── Cloudflare KV Adapter ──────────────────────────────────────────────────

function createMockKV(): CloudflareKVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value, options) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list(options) {
      const prefix = options?.prefix ?? "";
      return {
        keys: [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((name) => ({ name })),
      };
    },
  };
}

describe("Fix #3: Cloudflare KV Cache Adapter", () => {
  it("sets and gets a cache entry", async () => {
    const kv = createMockKV();
    const adapter = createCloudflareKVCacheAdapter({ namespace: kv });
    const key = cacheKey("/kv-page");
    await adapter.set(key, { html: "<p>KV</p>", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60 });
    const entry = await adapter.get(key);
    assert.ok(entry, "should return the entry");
    assert.equal(entry!.html, "<p>KV</p>");
  });

  it("deletes entries", async () => {
    const kv = createMockKV();
    const adapter = createCloudflareKVCacheAdapter({ namespace: kv });
    const key = cacheKey("/kv-delete");
    await adapter.set(key, { html: "temp", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60 });
    await adapter.delete(key);
    assert.equal(await adapter.get(key), null);
  });

  it("invalidates by tag", async () => {
    const kv = createMockKV();
    const adapter = createCloudflareKVCacheAdapter({ namespace: kv });
    const key1 = cacheKey("/kv-tag1");
    const key2 = cacheKey("/kv-tag2");
    await adapter.set(key1, { html: "a", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60, tags: ["news"] });
    await adapter.set(key2, { html: "b", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60, tags: ["news"] });
    await adapter.invalidateTags(["news"]);
    assert.equal(await adapter.get(key1), null, "key1 invalidated by tag");
    assert.equal(await adapter.get(key2), null, "key2 invalidated by tag");
  });
});
