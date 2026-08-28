import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { withContentRoot, getCollection, setContentRoot } from "../src/content/collections.ts";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CONTENT_ROOT_A = join(tmpdir(), `elur-content-a-${Date.now()}`);
const CONTENT_ROOT_B = join(tmpdir(), `elur-content-b-${Date.now()}`);

before(async () => {
  await mkdir(join(CONTENT_ROOT_A, "blog"), { recursive: true });
  await writeFile(join(CONTENT_ROOT_A, "blog", "post-a.md"), "---\ntitle: Post A\n---\nContent A");
  await mkdir(join(CONTENT_ROOT_B, "blog"), { recursive: true });
  await writeFile(join(CONTENT_ROOT_B, "blog", "post-b.md"), "---\ntitle: Post B\n---\nContent B");
});

after(async () => {
  await rm(CONTENT_ROOT_A, { recursive: true, force: true });
  await rm(CONTENT_ROOT_B, { recursive: true, force: true });
});

describe("content scope per request (plan §11.4)", () => {
  it("withContentRoot isolates content root per context", async () => {
    // Set global to A.
    setContentRoot(CONTENT_ROOT_A);

    // In root A context, should see post-a.
    const entriesA = await withContentRoot(CONTENT_ROOT_A, () => getCollection("blog"));
    assert.ok(entriesA.some((e) => e.slug === "post-a"));

    // In root B context, should see post-b.
    const entriesB = await withContentRoot(CONTENT_ROOT_B, () => getCollection("blog"));
    assert.ok(entriesB.some((e) => e.slug === "post-b"));
    assert.ok(!entriesB.some((e) => e.slug === "post-a"), "should not see A's entries in B context");
  });

  it("falls back to global content root when no per-request context", async () => {
    setContentRoot(CONTENT_ROOT_A);
    const entries = await getCollection("blog");
    assert.ok(entries.some((e) => e.slug === "post-a"));
  });
});

describe("content collection name containment (plan §11.4)", () => {
  it("rejects path traversal in collection names", async () => {
    await assert.rejects(
      () => getCollection("../etc"),
      /Invalid collection name/,
    );
  });

  it("rejects dots in collection names", async () => {
    await assert.rejects(
      () => getCollection("."),
      /Invalid collection name/,
    );
    await assert.rejects(
      () => getCollection(".."),
      /Invalid collection name/,
    );
  });

  it("rejects slashes in collection names", async () => {
    await assert.rejects(
      () => getCollection("blog/posts"),
      /Invalid collection name/,
    );
  });

  it("accepts valid collection names", async () => {
    setContentRoot(CONTENT_ROOT_A);
    // Should not throw.
    const entries = await getCollection("blog");
    assert.ok(entries.length > 0);
  });

  it("accepts hyphens and underscores", async () => {
    // These should not throw (even if the collection doesn't exist).
    try {
      await getCollection("my-blog");
      await getCollection("my_blog");
    } catch (err) {
      // If it throws, it should NOT be an "Invalid collection name" error.
      assert.ok(!(err instanceof Error && err.message.includes("Invalid collection name")));
    }
  });
});
