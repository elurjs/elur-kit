import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  CacheInvalidator,
  defaultInvalidator,
  connectCacheAdapter,
} from "../src/cache/invalidation.ts";
import { createFsCacheAdapter, cacheKey } from "../src/cache/adapter.ts";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CACHE_DIR = join(tmpdir(), `elur-inval-test-${Date.now()}`);

describe("cache invalidation (§9.4)", () => {
  it("CacheInvalidator dispatches events to listeners", async () => {
    const hub = new CacheInvalidator();
    const events: Array<{ tags?: string[]; paths?: string[] }> = [];

    hub.on((event) => {
      events.push({ tags: [...(event.tags ?? [])], paths: [...(event.paths ?? [])] });
    });

    await hub.invalidateTags(["products", "cart"]);
    await hub.invalidatePaths(["/products/1"]);

    assert.equal(events.length, 2);
    assert.deepEqual(events[0].tags, ["products", "cart"]);
    assert.deepEqual(events[1].paths, ["/products/1"]);
  });

  it("unsubscribe stops receiving events", async () => {
    const hub = new CacheInvalidator();
    let count = 0;

    const off = hub.on(() => { count++; });
    await hub.invalidateTags(["a"]);
    assert.equal(count, 1);

    off();
    await hub.invalidateTags(["b"]);
    assert.equal(count, 1, "should not receive events after unsubscribe");
  });

  it("listener errors are caught and do not block other listeners", async () => {
    const hub = new CacheInvalidator();
    let secondCalled = false;
    let firstCalled = false;

    // The invalidator catches errors from listeners (both sync throws and
    // async rejections), so the second listener should still be called.
    const originalError = console.error;
    console.error = () => { };
    try {
      hub.on(() => {
        firstCalled = true;
        throw new Error("listener 1 failed");
      });
      hub.on(() => { secondCalled = true; });

      await hub.invalidateTags(["test"]);
    } finally {
      console.error = originalError;
    }
    assert.ok(firstCalled, "first listener should have been called");
    assert.ok(secondCalled, "second listener should still be called");
  });

  it("connectCacheAdapter wires invalidation to adapter.invalidateTags", async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });
    const hub = new CacheInvalidator();

    const off = connectCacheAdapter(adapter, hub);

    // Set entries with tags.
    const key1 = cacheKey("/products/1");
    const key2 = cacheKey("/products/2");
    await adapter.set(key1, { html: "p1", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60, tags: ["products"] });
    await adapter.set(key2, { html: "p2", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60, tags: ["products"] });

    // Invalidate via the hub.
    await hub.invalidateTags(["products"], "submitProduct");

    // Both entries should be gone.
    assert.equal(await adapter.get(key1), null);
    assert.equal(await adapter.get(key2), null);

    off();
    await rm(CACHE_DIR, { recursive: true, force: true });
  });

  it("connectCacheAdapter wires path invalidation to adapter.delete", async () => {
    await mkdir(CACHE_DIR, { recursive: true });
    const adapter = createFsCacheAdapter({ cacheDir: CACHE_DIR });
    const hub = new CacheInvalidator();

    const off = connectCacheAdapter(adapter, hub);

    const key = cacheKey("/blog/post-1");
    await adapter.set(key, { html: "post", generatedAt: Date.now(), revalidate: 60 }, { revalidate: 60 });

    await hub.invalidatePaths(["/blog/post-1"]);

    assert.equal(await adapter.get(key), null, "path invalidation should delete the entry");

    off();
    await rm(CACHE_DIR, { recursive: true, force: true });
  });

  it("defaultInvalidator is a shared singleton", () => {
    assert.ok(defaultInvalidator instanceof CacheInvalidator);
  });
});
