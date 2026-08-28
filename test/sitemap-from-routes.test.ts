import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateSitemapFromRoutes } from "../src/seo/sitemap-from-routes.ts";
import type { ScannedRoutes } from "../src/router/route-scanner.ts";
import { rm, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const OUT_DIR = join(tmpdir(), `elur-sitemap-test-${Date.now()}`);

before(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

after(async () => {
  await rm(OUT_DIR, { recursive: true, force: true });
});

const mockRoutes: ScannedRoutes = {
  pages: [
    { path: "/", pagePath: "/page.ts", layouts: [] as string[], params: [] },
    { path: "/about", pagePath: "/about/page.ts", layouts: [] as string[], params: [] },
    { path: "/blog/:slug", pagePath: "/blog/[slug]/page.ts", layouts: [] as string[], params: ["slug"] },
    { path: "/404", pagePath: "/404.page.ts", layouts: [] as string[], params: [] },
    { path: "/500", pagePath: "/500.page.ts", layouts: [] as string[], params: [] },
  ],
  api: [
    { path: "/api/posts", routePath: "/api/posts/route.ts", params: [] },
  ],
};

describe("sitemap from routes (plan §11.3)", () => {
  it("generates sitemap from static routes only", async () => {
    const files = await generateSitemapFromRoutes({
      siteUrl: "https://example.com",
      outDir: OUT_DIR,
      routes: mockRoutes,
    });

    assert.equal(files.length, 1);
    const content = await readFile(files[0]!, "utf8");
    assert.ok(content.includes("<loc>https://example.com/</loc>"));
    assert.ok(content.includes("<loc>https://example.com/about</loc>"));
    // Dynamic routes should NOT be included.
    assert.ok(!content.includes("/blog/:slug"));
    // Error pages should NOT be included.
    assert.ok(!content.includes("/404"));
    assert.ok(!content.includes("/500"));
  });

  it("includes extra URLs", async () => {
    const files = await generateSitemapFromRoutes({
      siteUrl: "https://example.com",
      outDir: OUT_DIR,
      routes: mockRoutes,
      extraUrls: [
        "/blog/post-1",
        "/blog/post-2",
        { url: "/blog/post-3", changefreq: "weekly", priority: 0.8 },
      ],
    });

    const content = await readFile(files[0]!, "utf8");
    assert.ok(content.includes("/blog/post-1"));
    assert.ok(content.includes("/blog/post-2"));
    assert.ok(content.includes("/blog/post-3"));
    assert.ok(content.includes("<changefreq>weekly</changefreq>"));
    assert.ok(content.includes("<priority>0.8</priority>"));
  });

  it("applies default changefreq and priority", async () => {
    const files = await generateSitemapFromRoutes({
      siteUrl: "https://example.com",
      outDir: OUT_DIR,
      routes: mockRoutes,
      defaultChangefreq: "daily",
      defaultPriority: 0.5,
    });

    const content = await readFile(files[0]!, "utf8");
    assert.ok(content.includes("<changefreq>daily</changefreq>"));
    assert.ok(content.includes("<priority>0.5</priority>"));
  });

  it("generates sitemap index for large sites", async () => {
    // Generate 60,000 URLs to trigger the split.
    const extraUrls = Array.from({ length: 60000 }, (_, i) => `/page-${i}`);
    const files = await generateSitemapFromRoutes({
      siteUrl: "https://example.com",
      outDir: OUT_DIR,
      routes: mockRoutes,
      extraUrls,
      maxUrlsPerSitemap: 50000,
    });

    // Should have at least 2 sitemap files + 1 index.
    assert.ok(files.length >= 2, "should split into multiple files");

    // The last file should be the index (sitemap.xml).
    const indexContent = await readFile(files[files.length - 1]!, "utf8");
    assert.ok(indexContent.includes("<sitemapindex"), "should be a sitemap index");
    assert.ok(indexContent.includes("<sitemap>"), "should reference sub-sitemaps");
  });
});
