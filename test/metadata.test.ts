import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { documentShell, buildHeadTags } from "../src/build/document-shell.ts";
import type { PageMetadata } from "../src/types.ts";

describe("buildHeadTags", () => {
  it("emits title with data-elur-head", () => {
    const tags = buildHeadTags({ title: "Hello" }, "Fallback");
    assert.ok(tags.includes('<title data-elur-head>Hello</title>'));
  });

  it("emits meta description", () => {
    const tags = buildHeadTags({ description: "A test page" }, "Fallback");
    assert.ok(tags.includes('name="description" content="A test page"'));
    assert.ok(tags.includes("data-elur-head"));
  });

  it("emits canonical link", () => {
    const tags = buildHeadTags({ canonical: "https://example.com/page" }, "Fallback");
    assert.ok(tags.includes('rel="canonical" href="https://example.com/page"'));
  });

  it("emits robots directive", () => {
    const tags = buildHeadTags({ robots: "noindex, nofollow" }, "Fallback");
    assert.ok(tags.includes('name="robots" content="noindex, nofollow"'));
  });

  it("emits OpenGraph tags with fallbacks", () => {
    const tags = buildHeadTags(
      { title: "My Page", description: "Desc", openGraph: { type: "article", image: "/img.jpg" } },
      "Fallback",
    );
    assert.ok(tags.includes('property="og:type" content="article"'));
    assert.ok(tags.includes('property="og:title" content="My Page"'));
    assert.ok(tags.includes('property="og:description" content="Desc"'));
    assert.ok(tags.includes('property="og:image" content="/img.jpg"'));
  });

  it("emits Twitter card tags", () => {
    const tags = buildHeadTags(
      { title: "My Page", twitter: { card: "summary_large_image", image: "/img.jpg" } },
      "Fallback",
    );
    assert.ok(tags.includes('name="twitter:card" content="summary_large_image"'));
    assert.ok(tags.includes('name="twitter:title" content="My Page"'));
    assert.ok(tags.includes('name="twitter:image" content="/img.jpg"'));
  });

  it("emits custom other meta tags", () => {
    const tags = buildHeadTags({ other: { author: "Ada" } }, "Fallback");
    assert.ok(tags.includes('name="author" content="Ada"'));
  });

  it("returns empty string for empty metadata", () => {
    const tags = buildHeadTags({}, "Fallback");
    assert.equal(tags, "");
  });
});

describe("documentShell with metadata", () => {
  it("includes head tags when metadata is provided", () => {
    const html = documentShell({
      body: "<p>hi</p>",
      metadata: { title: "My Page", description: "Test" },
    });
    assert.ok(html.includes('<title data-elur-head>My Page</title>'));
    assert.ok(html.includes('name="description" content="Test"'));
  });

  it("falls back to plain title when no metadata", () => {
    const html = documentShell({
      body: "<p>hi</p>",
      title: "Plain Title",
    });
    assert.ok(html.includes("<title>Plain Title</title>"));
    assert.ok(!html.includes("data-elur-head"));
  });

  it("does not emit duplicate title tags", () => {
    const html = documentShell({
      body: "<p>hi</p>",
      title: "Fallback",
      metadata: { title: "Meta Title" },
    });
    // Should have only one <title> tag, and it should be the metadata one.
    const titleCount = (html.match(/<title/g) || []).length;
    assert.equal(titleCount, 1);
    assert.ok(html.includes('<title data-elur-head>Meta Title</title>'));
  });

  it("escapes HTML in metadata values", () => {
    const html = documentShell({
      body: "<p>hi</p>",
      metadata: { title: '<script>alert(1)</script>', description: '"><img onerror=x>' },
    });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("&quot;&gt;"));
  });
});
