import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig, loadElurConfig } from "../src/config/index.ts";
import { createAppManifest, validateManifestRoutes, writeAppManifest, writeRouteTypes } from "../src/manifest/index.ts";
import type { ScannedRoutes } from "../src/router/route-scanner.ts";

const fixtureRoot = resolve(import.meta.dirname, "fixtures/minimal");

describe("Elur config", () => {
  it("resolves typed defaults", async () => {
    const config = await loadElurConfig({ root: fixtureRoot });
    assert.equal(config.appDir, resolve(fixtureRoot, "src/app"));
    assert.equal(config.publicDir, resolve(fixtureRoot, "public"));
    assert.equal(config.base, "/");
    assert.equal(config.output, "static");
  });

  it("loads an ESM config and normalizes base", async () => {
    const root = await mkdtemp(join(tmpdir(), "elur-config-"));
    try {
      await writeFile(join(root, "elur.config.mjs"), "export default { appDir: 'app', base: '/docs', output: 'server' }", "utf8");
      const config = await loadElurConfig({ root, command: "build" });
      assert.equal(config.appDir, join(root, "app"));
      assert.equal(config.base, "/docs/");
      assert.equal(config.output, "server");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects configured directories outside root", async () => {
    await assert.rejects(
      loadElurConfig({ root: fixtureRoot, overrides: defineConfig({ outDir: "../outside" }) }),
      /inside root/,
    );
  });
});

describe("application manifest", () => {
  it("combines routes, actions and islands and writes portable outputs", async () => {
    const config = await loadElurConfig({ root: fixtureRoot });
    const manifest = await createAppManifest(config);
    assert.ok(manifest.routes.pages.some((route) => route.path === "/"));
    assert.ok(manifest.routes.api.some((route) => route.path === "/api/posts/:id"));
    assert.ok(manifest.actions["/"].greet);

    const output = await mkdtemp(join(tmpdir(), "elur-manifest-"));
    try {
      const manifestPath = join(output, "manifest.json");
      const typesPath = join(output, "types.d.ts");
      await writeAppManifest(manifest, manifestPath);
      await writeRouteTypes(manifest, typesPath);
      const serialized = JSON.parse(await readFile(manifestPath, "utf8")) as { root: string; routes: { pages: Array<{ pagePath: string }> } };
      assert.equal(serialized.root, ".");
      assert.ok(!serialized.routes.pages[0].pagePath.startsWith("/"));
      assert.match(await readFile(typesPath, "utf8"), /ElurRoutePath/);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it("rejects route conflicts and reserved namespaces", () => {
    const duplicate = {
      pages: [
        { path: "/same", pagePath: "/a.ts", layouts: [], params: [] },
        { path: "/same", pagePath: "/b.ts", layouts: [], params: [] },
      ],
      api: [],
    } as ScannedRoutes;
    assert.throws(() => validateManifestRoutes(duplicate), /Duplicate/);

    const reserved = {
      pages: [{ path: "/_elur/private", pagePath: "/a.ts", layouts: [], params: [] }],
      api: [],
    } as ScannedRoutes;
    assert.throws(() => validateManifestRoutes(reserved), /Reserved/);
  });
});
