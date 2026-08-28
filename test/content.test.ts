import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  parseDocument,
  parseFrontmatter,
  splitFrontmatter,
} from "../src/content/frontmatter.ts";
import {
  defineCollection,
  getCollection,
  getEntry,
  setContentRoot,
  clearContentCache,
} from "../src/content/collections.ts";
import { createValidator } from "../src/content/schema.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contentRoot = resolve(__dirname, "fixtures/content");

describe("splitFrontmatter", () => {
  it("splits frontmatter and body", () => {
    const source = "---\ntitle: Test\n---\n# Body";
    const { raw, body } = splitFrontmatter(source);
    assert.equal(raw, "title: Test");
    assert.equal(body, "# Body");
  });

  it("returns empty raw when no frontmatter", () => {
    const { raw, body } = splitFrontmatter("Just body");
    assert.equal(raw, "");
    assert.equal(body, "Just body");
  });

  it("handles missing closing fence", () => {
    const { raw, body } = splitFrontmatter("---\ntitle: Test\nNo close");
    assert.equal(raw, "");
    assert.equal(body, "---\ntitle: Test\nNo close");
  });
});

describe("parseFrontmatter", () => {
  it("parses string values", () => {
    const data = parseFrontmatter('title: "Hello"');
    assert.equal(data.title, "Hello");
  });

  it("parses unquoted strings", () => {
    const data = parseFrontmatter("title: Hello World");
    assert.equal(data.title, "Hello World");
  });

  it("parses integers", () => {
    const data = parseFrontmatter("count: 42");
    assert.equal(data.count, 42);
  });

  it("parses floats", () => {
    const data = parseFrontmatter("rating: 4.5");
    assert.equal(data.rating, 4.5);
  });

  it("parses booleans", () => {
    const data = parseFrontmatter("draft: true\npublished: false");
    assert.equal(data.draft, true);
    assert.equal(data.published, false);
  });

  it("parses null", () => {
    const data = parseFrontmatter("optional: null");
    assert.equal(data.optional, null);
  });

  it("parses ISO dates", () => {
    const data = parseFrontmatter("date: 2026-08-15");
    assert.ok(data.date instanceof Date);
    assert.equal((data.date as Date).toISOString().slice(0, 10), "2026-08-15");
  });

  it("parses inline arrays", () => {
    const data = parseFrontmatter('tags: ["a", "b", "c"]');
    assert.deepEqual(data.tags, ["a", "b", "c"]);
  });

  it("parses block arrays", () => {
    const raw = "tags:\n  - foo\n  - bar";
    const data = parseFrontmatter(raw);
    assert.deepEqual(data.tags, ["foo", "bar"]);
  });

  it("skips comments", () => {
    const data = parseFrontmatter("# comment\ntitle: Test");
    assert.equal(data.title, "Test");
  });

  it("handles single-quoted strings", () => {
    const data = parseFrontmatter("title: 'It''s a test'");
    assert.equal(data.title, "It's a test");
  });
});

describe("parseDocument", () => {
  it("parses frontmatter and body together", () => {
    const source = "---\ntitle: Hello\ndate: 2026-08-15\n---\n# Body text";
    const { data, body } = parseDocument(source);
    assert.equal(data.title, "Hello");
    assert.ok(data.date instanceof Date);
    assert.equal(body, "# Body text");
  });
});

describe("createValidator", () => {
  it("validates with a function schema", () => {
    const validator = createValidator((data: Record<string, unknown>) => {
      if (!data.title) throw new Error("title is required");
      return data;
    });
    assert.ok(validator);
    const result = validator!({ title: "OK" }, "test.md");
    assert.equal(result.title, "OK");
  });

  it("throws on invalid data", () => {
    const validator = createValidator((data: Record<string, unknown>) => {
      if (!data.title) throw new Error("title is required");
      return data;
    });
    assert.throws(() => validator!({}, "test.md"), /title is required/);
  });

  it("returns undefined for no schema", () => {
    assert.equal(createValidator(undefined), undefined);
  });
});

describe("getCollection / getEntry", () => {
  it("returns all entries in a collection", async () => {
    setContentRoot(contentRoot);
    clearContentCache();
    const entries = await getCollection("blog");
    assert.equal(entries.length, 3);
    // Sorted by date descending: hello-world (Aug 15) before second-post (Aug 10).
    assert.equal(entries[0].slug, "hello-world");
    assert.equal(entries[1].slug, "second-post");
  });

  it("parses frontmatter correctly", async () => {
    setContentRoot(contentRoot);
    clearContentCache();
    const entry = await getEntry("blog", "hello-world");
    assert.ok(entry);
    assert.equal(entry!.data.title, "Hello World");
    assert.ok(entry!.data.date instanceof Date);
    assert.deepEqual(entry!.data.tags, ["intro", "elur"]);
    assert.equal(entry!.data.draft, false);
  });

  it("parses inline arrays and floats", async () => {
    setContentRoot(contentRoot);
    clearContentCache();
    const entry = await getEntry("blog", "second-post");
    assert.ok(entry);
    assert.deepEqual(entry!.data.tags, ["advanced", "guide"]);
    assert.equal(entry!.data.rating, 4.5);
  });

  it("returns undefined for non-existent slug", async () => {
    setContentRoot(contentRoot);
    clearContentCache();
    const entry = await getEntry("blog", "does-not-exist");
    assert.equal(entry, undefined);
  });

  it("returns empty array for non-existent collection", async () => {
    setContentRoot(contentRoot);
    clearContentCache();
    const entries = await getCollection("nonexistent");
    assert.deepEqual(entries, []);
  });

  it("includes the markdown body", async () => {
    setContentRoot(contentRoot);
    clearContentCache();
    const entry = await getEntry("blog", "hello-world");
    assert.ok(entry);
    assert.ok(entry!.body.includes("# Hello World"));
    assert.ok(entry!.body.includes("**test**"));
  });
});

describe("defineCollection", () => {
  it("returns the definition as-is", () => {
    const def = defineCollection({ schema: undefined });
    assert.deepEqual(def, { schema: undefined });
  });
});

describe("getCollection recursive scanning", () => {
  it("scans nested directories and derives nested slugs", async () => {
    setContentRoot(contentRoot);
    clearContentCache();
    const entries = await getCollection("blog");
    const deep = entries.find((e) => e.slug === "nested/deep");
    assert.ok(deep, "nested file should have slug 'nested/deep'");
    assert.equal((deep!.data as { title: string }).title, "Deep Post");
    assert.equal(entries.length, 3, "should include the nested entry");
  });
});
