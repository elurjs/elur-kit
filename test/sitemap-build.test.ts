import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../src/build/build.ts";

/**
 * Verifies the automatic sitemap generation wired into build():
 *  - with `site` configured, sitemap.xml is generated from the scanned routes;
 *  - without `site`, no sitemap is written;
 *  - an existing sitemap.xml (e.g. from public/ or an integration) is never
 *    overwritten.
 */
describe("build: automatic sitemap", () => {
  const tmpDir = join(import.meta.dirname, ".tmp-sitemap-build");
  const appDir = join(tmpDir, "app");

  async function writeFixture(): Promise<void> {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, "page.ts"),
      `import { html } from "@elurjs/core";\nexport default function Page() { return html\`<h1>Home</h1>\`; }\n`,
    );
  }

  it("generates sitemap.xml when site is configured", async () => {
    await writeFixture();
    const outDir = join(tmpDir, "dist-site");
    try {
      const result = await build({ appDir, outDir, site: "https://example.com" });
      const sitemap = await readFile(join(outDir, "sitemap.xml"), "utf8");
      assert.ok(sitemap.includes("<loc>https://example.com/</loc>"), "should include the home page");
      assert.ok(result.files.some((f) => f.endsWith("sitemap.xml")), "sitemap should be listed in result.files");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not generate a sitemap without site", async () => {
    await writeFixture();
    const outDir = join(tmpDir, "dist-no-site");
    try {
      await build({ appDir, outDir });
      await assert.rejects(stat(join(outDir, "sitemap.xml")), "sitemap.xml should not exist");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("never overwrites an existing sitemap.xml", async () => {
    await writeFixture();
    const publicDir = join(tmpDir, "public");
    const outDir = join(tmpDir, "dist-existing");
    await mkdir(publicDir, { recursive: true });
    await writeFile(join(publicDir, "sitemap.xml"), "<!-- custom sitemap -->", "utf8");
    try {
      await build({ appDir, outDir, publicDir, site: "https://example.com" });
      const sitemap = await readFile(join(outDir, "sitemap.xml"), "utf8");
      assert.equal(sitemap, "<!-- custom sitemap -->", "existing sitemap should win");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
