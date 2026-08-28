import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  beginAtomicStage,
  copyPublicAssets,
  buildClientBundle,
} from "../src/build/vite-build.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "fixtures/minimal");
const tempBase = resolve(root, ".tmp-vite-build-test");

describe("vite-build: atomic staging", () => {
  after(async () => {
    await rm(tempBase, { recursive: true, force: true });
  });

  it("builds into a temp dir and swaps to the final destination on commit", async () => {
    const outDir = join(tempBase, "atomic-out");
    const stage = await beginAtomicStage({ outDir });
    assert.ok(!existsSync(outDir), "outDir should not exist yet");
    assert.ok(existsSync(stage.tempDir), "tempDir should exist");

    await writeFile(join(stage.tempDir, "index.html"), "<h1>staged</h1>", "utf8");
    await stage.commit();

    assert.ok(existsSync(outDir), "outDir should exist after commit");
    const content = await readFile(join(outDir, "index.html"), "utf8");
    assert.equal(content, "<h1>staged</h1>");
    assert.ok(!existsSync(stage.tempDir), "tempDir should be gone after commit");
  });

  it("cleans up the temp dir on rollback", async () => {
    const outDir = join(tempBase, "atomic-rollback");
    const stage = await beginAtomicStage({ outDir });

    await writeFile(join(stage.tempDir, "partial.txt"), "data", "utf8");
    await stage.rollback();

    assert.ok(!existsSync(stage.tempDir), "tempDir should be removed on rollback");
    assert.ok(!existsSync(outDir), "outDir should not exist after rollback");
  });

  it("preserves existing output via backup when keepExisting is true", async () => {
    const outDir = join(tempBase, "atomic-keep");
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "old.txt"), "old", "utf8");

    const stage = await beginAtomicStage({ outDir, keepExisting: true });
    await writeFile(join(stage.tempDir, "new.txt"), "new", "utf8");
    await stage.commit();

    assert.ok(existsSync(outDir), "outDir should exist after commit");
    assert.ok(existsSync(join(outDir, "new.txt")), "new file should be present");
    assert.ok(!existsSync(join(outDir, "old.txt")), "old file should be replaced");
  });
});

describe("vite-build: copyPublicAssets", () => {
  const publicDir = join(tempBase, "public");
  const outDir = join(tempBase, "assets-out");

  before(async () => {
    await mkdir(publicDir, { recursive: true });
    await mkdir(join(publicDir, "sub"), { recursive: true });
    await writeFile(join(publicDir, "favicon.ico"), "ico", "utf8");
    await writeFile(join(publicDir, "sub", "style.css"), "body{}", "utf8");
  });

  after(async () => {
    await rm(tempBase, { recursive: true, force: true });
  });

  it("copies public directory contents into the output directory", async () => {
    const count = await copyPublicAssets({ publicDir, outDir });
    assert.ok(count >= 2, `should copy at least 2 files, got ${count}`);
    assert.ok(existsSync(join(outDir, "favicon.ico")));
    assert.ok(existsSync(join(outDir, "sub", "style.css")));
  });

  it("returns 0 when public dir does not exist", async () => {
    const count = await copyPublicAssets({
      publicDir: join(tempBase, "nonexistent"),
      outDir: join(tempBase, "no-assets"),
    });
    assert.equal(count, 0);
  });
});

describe("vite-build: programmatic client bundle", () => {
  const clientConfigPath = join(tempBase, "vite.client.config.mjs");
  const clientOutDir = join(tempBase, "client-out");
  const appDir = resolve(root, "src", "app");
  const islandsDir = resolve(root, "src", "islands");

  before(async () => {
    await mkdir(tempBase, { recursive: true });
    // Minimal Vite client config that just bundles a tiny entry.
    await writeFile(
      clientConfigPath,
      [
        'import { defineConfig } from "vite";',
        'export default defineConfig({',
        '  build: {',
        '    target: "es2020",',
        '    rollupOptions: {',
        '      input: "entry.ts",',
        '    },',
        '  },',
        '});',
        '',
      ].join("\n"),
      "utf8",
    );
    // Create a tiny entry file in the temp dir so Vite can resolve it.
    await writeFile(join(tempBase, "entry.ts"), 'console.log("elur-kit client entry");', "utf8");
  });

  after(async () => {
    await rm(tempBase, { recursive: true, force: true });
  });

  it("builds a client bundle using the Vite JS API", async () => {
    const result = await buildClientBundle({
      root: tempBase,
      userConfigPath: clientConfigPath,
      appDir,
      islandsDir,
      outDir: clientOutDir,
      logPrefix: "[test-client]",
    });

    assert.equal(result.outDir, clientOutDir);
    assert.ok(result.outputCount > 0, "should emit at least one asset");
    // Vite should emit a JS chunk (possibly hashed) in the assets directory.
    const assetsDir = join(clientOutDir, "assets");
    const files = await readdir(assetsDir);
    const jsFiles = files.filter((f) => f.endsWith(".js"));
    assert.ok(jsFiles.length > 0, "should emit at least one JS file in assets/");
  });
});
