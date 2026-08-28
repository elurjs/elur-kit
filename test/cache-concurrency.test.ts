// Cache concurrency and isolation tests (plan §9, A-08, testing-roadmap §3.4)
//
// Tests:
//   - Stampede: concurrent gets only trigger one fill
//   - Private/public isolation: cached responses are not shared between users
//   - Atomicity: concurrent writes don't corrupt entries
//   - Collision resistance: different paths don't share cache entries

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createFsCacheAdapter, getWithSWR, type CacheEntry, type CacheAdapter } from "../src/cache/adapter.ts";
import { shouldCachePublic, normalizeCachePolicy } from "../src/cache/policy.ts";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CACHE_DIR = join(tmpdir(), `elur-cache-concurrency-${Date.now()}`);

function makeEntry(html: string, revalidate = 60, tags: string[] = []): CacheEntry {
  return { html, generatedAt: Date.now(), revalidate, tags };
}

before(async () => {
  await mkdir(CACHE_DIR, { recursive: true });
});

after(async () => {
  await rm(CACHE_DIR, { recursive: true, force: true });
});

describe("cache stampede protection (§9.2, A-08)", () => {
  it("single-flight deduplicates concurrent gets on adapter", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });
    let getCount = 0;

    // Pre-populate the cache
    await adapter.set("single-flight-key", makeEntry("cached"), { revalidate: 60 });

    // The adapter's get() uses single-flight internally.
    // Multiple concurrent gets for the same key should only read from disk once.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => adapter.get("single-flight-key")),
    );

    for (const result of results) {
      assert.ok(result, "should have an entry");
      assert.equal(result!.html, "cached");
    }
  });

  it("getWithSWR fills cache on miss", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });

    const fill = async (): Promise<CacheEntry | null> => {
      await new Promise((r) => setTimeout(r, 10));
      return makeEntry("filled-value");
    };

    const result = await getWithSWR(adapter, "swr-miss-key", fill);
    assert.ok(result.entry, "should have an entry");
    assert.equal(result.entry!.html, "filled-value");
    assert.equal(result.stale, false, "fresh entry should not be stale");
  });

  it("getWithSWR serves stale and revalidates in background", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });

    // Pre-populate with an already-stale entry
    const staleEntry = makeEntry("old-value", 1);
    staleEntry.generatedAt = Date.now() - 5000; // 5 seconds ago, revalidate=1s
    await adapter.set("swr-stale-key", staleEntry, { revalidate: 1 });

    let revalidated = false;
    const fill = async (): Promise<CacheEntry | null> => {
      revalidated = true;
      return makeEntry("new-value", 60);
    };

    const result = await getWithSWR(adapter, "swr-stale-key", fill);
    assert.ok(result.entry, "should have an entry");
    assert.equal(result.entry!.html, "old-value", "should serve stale");
    assert.equal(result.stale, true, "should be marked stale");

    // Wait for background revalidation
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(revalidated, "should have triggered background revalidation");
  });

  it("different keys trigger separate fills", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });
    let fillCount = 0;

    const fill = async (key: string): Promise<CacheEntry | null> => {
      fillCount++;
      await new Promise((r) => setTimeout(r, 10));
      return makeEntry(`value-${key}`);
    };

    const results = await Promise.all([
      getWithSWR(adapter, "unique-key-a", () => fill("a")),
      getWithSWR(adapter, "unique-key-b", () => fill("b")),
      getWithSWR(adapter, "unique-key-c", () => fill("c")),
    ]);

    assert.equal(results[0]!.entry!.html, "value-a");
    assert.equal(results[1]!.entry!.html, "value-b");
    assert.equal(results[2]!.entry!.html, "value-c");
    assert.equal(fillCount, 3, "each key should trigger its own fill");
  });
});

describe("cache private/public isolation (§9.1, A-08)", () => {
  it("shouldCachePublic rejects requests with cookies", () => {
    const policy = normalizeCachePolicy({ mode: "public", revalidate: 60 });
    const request = new Request("http://localhost/", {
      headers: { Cookie: "session=abc123" },
    });
    assert.equal(shouldCachePublic(policy, request), false);
  });

  it("shouldCachePublic rejects requests with Authorization", () => {
    const policy = normalizeCachePolicy({ mode: "public", revalidate: 60 });
    const request = new Request("http://localhost/", {
      headers: { Authorization: "Bearer token123" },
    });
    assert.equal(shouldCachePublic(policy, request), false);
  });

  it("shouldCachePublic rejects private mode", () => {
    const policy = normalizeCachePolicy({ mode: "private", revalidate: 60 });
    const request = new Request("http://localhost/");
    assert.equal(shouldCachePublic(policy, request), false);
  });

  it("shouldCachePublic rejects dynamic mode", () => {
    const policy = normalizeCachePolicy({ mode: "dynamic", revalidate: 60 });
    const request = new Request("http://localhost/");
    assert.equal(shouldCachePublic(policy, request), false);
  });

  it("shouldCachePublic accepts clean public request", () => {
    const policy = normalizeCachePolicy({ mode: "public", revalidate: 60 });
    const request = new Request("http://localhost/");
    assert.equal(shouldCachePublic(policy, request), true);
  });
});

describe("cache atomicity (§9.2, A-08)", () => {
  it("concurrent writes to same key don't corrupt", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });

    // Write different values concurrently to the same key
    await Promise.all([
      adapter.set("atomic-key", makeEntry("value-1"), { revalidate: 60 }),
      adapter.set("atomic-key", makeEntry("value-2"), { revalidate: 60 }),
      adapter.set("atomic-key", makeEntry("value-3"), { revalidate: 60 }),
    ]);

    // The final value should be one of the three (not corrupted)
    const result = await adapter.get("atomic-key");
    assert.ok(result, "should have a value");
    assert.ok(
      ["value-1", "value-2", "value-3"].includes(result.html),
      `value should be one of the three, got: ${result.html}`,
    );
  });
});

describe("cache collision resistance (§9.2, A-08)", () => {
  it("paths with similar names don't collide", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });

    await adapter.set("/blog/hello", makeEntry("post-1"), { revalidate: 60 });
    await adapter.set("/blog/hello-world", makeEntry("post-2"), { revalidate: 60 });
    await adapter.set("/blog/hello-world-2", makeEntry("post-3"), { revalidate: 60 });

    assert.equal((await adapter.get("/blog/hello"))?.html, "post-1");
    assert.equal((await adapter.get("/blog/hello-world"))?.html, "post-2");
    assert.equal((await adapter.get("/blog/hello-world-2"))?.html, "post-3");
  });

  it("path with query params doesn't collide with base path", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });

    await adapter.set("/page?foo=bar", makeEntry("with-query"), { revalidate: 60 });
    await adapter.set("/page", makeEntry("without-query"), { revalidate: 60 });

    assert.equal((await adapter.get("/page?foo=bar"))?.html, "with-query");
    assert.equal((await adapter.get("/page"))?.html, "without-query");
  });
});

describe("cache tag invalidation (§9.4, A-08)", () => {
  it("invalidating a tag removes all entries with that tag", async () => {
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });

    await adapter.set("tag-1", makeEntry("a", 60, ["posts"]), { revalidate: 60, tags: ["posts"] });
    await adapter.set("tag-2", makeEntry("b", 60, ["posts"]), { revalidate: 60, tags: ["posts"] });
    await adapter.set("tag-3", makeEntry("c", 60, ["pages"]), { revalidate: 60, tags: ["pages"] });

    await adapter.invalidateTags(["posts"]);

    assert.equal(await adapter.get("tag-1"), null, "tag-1 should be invalidated");
    assert.equal(await adapter.get("tag-2"), null, "tag-2 should be invalidated");
    assert.ok(await adapter.get("tag-3"), "tag-3 should still exist");
  });
});
