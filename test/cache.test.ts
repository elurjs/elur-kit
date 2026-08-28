import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCachedHtml, setCachedHtml } from "../src/cache.ts";

describe("ISR filesystem cache", () => {
  it("does not collide for paths that normalize to the same legacy filename", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "elur-cache-"));
    try {
      await setCachedHtml(cacheDir, "/a/b", "nested", 60);
      await setCachedHtml(cacheDir, "/a_b", "underscore", 60);
      assert.equal((await getCachedHtml(cacheDir, "/a/b"))?.html, "nested");
      assert.equal((await getCachedHtml(cacheDir, "/a_b"))?.html, "underscore");
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("uses atomic temporary files for concurrent writes", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "elur-cache-"));
    try {
      await Promise.all(Array.from({ length: 20 }, (_, index) =>
        setCachedHtml(cacheDir, "/same", `value-${index}`, 60),
      ));
      const cached = await getCachedHtml(cacheDir, "/same");
      assert.ok(cached?.html.startsWith("value-"));
      assert.ok((await readdir(cacheDir)).every((name) => !name.endsWith(".tmp")));
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
