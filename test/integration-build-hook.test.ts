import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "../src/build/build.ts";
import type { ElurKitIntegration } from "../src/integrations/index.ts";

/**
 * Verifies that the `build` integration hook fires at the end of build()
 * and that artifacts written by the integration survive into the output
 * directory.
 *
 * Regression test for the bug where ElurKitIntegration.build was declared
 * in the interface but never invoked from build.ts.
 */
describe("integration build hook", () => {
  it("invokes the build hook after pages are generated", async () => {
    const tmpDir = join(import.meta.dirname, ".tmp-build-hook-test");
    const appDir = join(tmpDir, "app");
    const outDir = join(tmpDir, "dist");

    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, "page.ts"),
      `import { html } from "@elurjs/core";\nexport default function Page() { return html\`<h1>Home</h1>\`; }\n`,
    );

    let hookCalled = false;
    let receivedResult: { pages: number; outDir: string } | null = null;
    let receivedContext: { command: string; root: string } | null = null;

    const integration: ElurKitIntegration = {
      name: "test-build-hook",
      build: async (result, context) => {
        hookCalled = true;
        receivedResult = result as { pages: number; outDir: string };
        receivedContext = context as { command: string; root: string };
        // Write a post-build artifact (e.g. sitemap.xml) into the build's outDir.
        await writeFile(join(receivedResult.outDir, "sitemap.xml"), "<urlset></urlset>");
      },
    };

    try {
      await build({
        appDir,
        outDir,
        integrations: [integration],
      });

      assert.ok(hookCalled, "build hook should have been called");
      assert.equal(receivedResult!.pages, 1, "hook should receive the build result with 1 page");
      assert.equal(receivedResult!.outDir, outDir, "hook should receive the correct outDir");
      assert.equal(receivedContext!.command, "build", "hook context command should be 'build'");

      const sitemap = await readFile(join(outDir, "sitemap.xml"), "utf8");
      assert.equal(sitemap, "<urlset></urlset>", "integration artifact should exist in outDir");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not fail when no integrations are provided", async () => {
    const tmpDir = join(import.meta.dirname, ".tmp-build-hook-noop");
    const appDir = join(tmpDir, "app");
    const outDir = join(tmpDir, "dist");

    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, "page.ts"),
      `import { html } from "@elurjs/core";\nexport default function Page() { return html\`<h1>Home</h1>\`; }\n`,
    );

    try {
      const result = await build({ appDir, outDir });
      assert.equal(result.pages, 1, "build should succeed without integrations");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
