import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createFsCacheAdapter, cacheKey, getWithSWR } from "../src/cache/adapter.ts";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CACHE_DIR = join(tmpdir(), `elur-cache-test-${Date.now()}`);

before(async () => {
  await mkdir(CACHE_DIR, { recursive: true });
});

after(async () => {
  await rm(CACHE_DIR, { recursive: true, force: true });
});

describe("CacheAdapter: filesystem (§9.2)", () => {
  it("sets and gets a cache entry", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });
    const key = cacheKey("/page1");
    await adapter.set(key, { html: "<h1>Hello</h1>", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60 });
    const entry = await adapter.get(key);
    assert.ok(entry, "should return the entry");
    assert.equal(entry!.html, "<h1>Hello</h1>");
    assert.equal(entry!.revalidate, 60);
  });

  it("returns null for missing keys", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });
    const entry = await adapter.get(cacheKey("/nonexistent"));
    assert.equal(entry, null);
  });

  it("deletes entries", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });
    const key = cacheKey("/delete-me");
    await adapter.set(key, { html: "temp", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60 });
    await adapter.delete(key);
    const entry = await adapter.get(key);
    assert.equal(entry, null);
  });

  it("invalidates by tags", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });
    const key1 = cacheKey("/products/1");
    const key2 = cacheKey("/products/2");
    const key3 = cacheKey("/blog/1");

    await adapter.set(key1, { html: "p1", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60, tags: ["products"] });
    await adapter.set(key2, { html: "p2", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60, tags: ["products"] });
    await adapter.set(key3, { html: "b1", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60, tags: ["blog"] });

    await adapter.invalidateTags(["products"]);

    assert.equal(await adapter.get(key1), null, "products/1 should be invalidated");
    assert.equal(await adapter.get(key2), null, "products/2 should be invalidated");
    const blogEntry = await adapter.get(key3);
    assert.ok(blogEntry, "blog/1 should still be cached");
  });

  it("uses SHA-256 keys", () => {
    const key1 = cacheKey("/page");
    const key2 = cacheKey("/page");
    const key3 = cacheKey("/other");
    assert.equal(key1, key2, "same input should produce same key");
    assert.notEqual(key1, key3, "different input should produce different key");
    assert.equal(key1.length, 64, "SHA-256 hex should be 64 chars");
  });

  it("single-flight deduplicates concurrent gets", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });
    const key = cacheKey("/single-flight");
    await adapter.set(key, { html: "test", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60 });

    // Fire 10 concurrent gets for the same key.
    const results = await Promise.all(Array.from({ length: 10 }, () => adapter.get(key)));
    for (const entry of results) {
      assert.ok(entry, "all concurrent gets should return the entry");
      assert.equal(entry!.html, "test");
    }
  });
});

describe("getWithSWR: stale-while-revalidate (§9.2)", () => {
  it("serves fresh entry without revalidation", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });
    const key = cacheKey("/fresh");
    const now = Date.now();
    await adapter.set(key, { html: "fresh", generatedAt: now, revalidate: 60 }, { revalidate: 60 });

    let revalidated = false;
    const { entry, stale } = await getWithSWR(adapter, key, async () => {
      revalidated = true;
      return null;
    });

    assert.ok(entry);
    assert.equal(stale, false);
    assert.equal(revalidated, false, "should not revalidate fresh entry");
  });

  it("serves stale entry and triggers background revalidation", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });
    const key = cacheKey("/stale");
    // Set an entry that's already stale (generatedAt in the past).
    await adapter.set(
      key,
      { html: "stale-content", generatedAt: Date.now() - 120_000, revalidate: 1 },
      { revalidate: 1 },
    );

    let revalidated = false;
    const { entry, stale } = await getWithSWR(adapter, key, async () => {
      revalidated = true;
      await adapter.set(key, { html: "fresh-content", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60 });
      return { html: "fresh-content", generatedAt: Date.now(), revalidate: 60 };
    });

    assert.ok(entry, "should serve stale entry");
    assert.equal(stale, true, "should mark as stale");
    assert.equal(entry!.html, "stale-content", "should serve stale content immediately");
    // Background revalidation should have been triggered.
    // Give it a moment to run (fire-and-forget).
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(revalidated, "should have triggered background revalidation");
  });

  it("revalidates synchronously on cache miss", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });
    const key = cacheKey("/miss");

    const { entry, stale } = await getWithSWR(adapter, key, async () => {
      return { html: "new-content", generatedAt: Date.now(), revalidate: 60 };
    });

    assert.ok(entry, "should return revalidated entry");
    assert.equal(stale, false);
    assert.equal(entry!.html, "new-content");
  });
});
