import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { scanRoutes } from "../src/router/route-scanner.ts";
import { matchRoute } from "../src/ssr/match.ts";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const APP_DIR = join(tmpdir(), `elur-route-test-${Date.now()}`);

before(async () => {
  await mkdir(join(APP_DIR, "blog", "[slug]"), { recursive: true });
  await mkdir(join(APP_DIR, "docs", "[[...slug]]"), { recursive: true });
  await mkdir(join(APP_DIR, "about"), { recursive: true });
  await writeFile(join(APP_DIR, "page.ts"), "export default () => null;");
  await writeFile(join(APP_DIR, "blog", "[slug]", "page.ts"), "export default () => null;");
  await writeFile(join(APP_DIR, "docs", "[[...slug]]", "page.ts"), "export default () => null;");
  await writeFile(join(APP_DIR, "about", "page.ts"), "export default () => null;");
});

after(async () => {
  await rm(APP_DIR, { recursive: true, force: true });
});

describe("route scanner: optional catch-all (plan §11.1)", () => {
  it("scans [[...slug]] as optional catch-all", async () => {
    const routes = await scanRoutes(APP_DIR);
    const docsRoute = routes.pages.find((r) => r.path.includes("docs"));
    assert.ok(docsRoute, "should find docs route");
    assert.ok(docsRoute!.optionalCatchAll, "should be marked as optional catch-all");
    assert.ok(docsRoute!.path.includes(":slug*"), "path should have catch-all pattern");
  });

  it("optional catch-all matches the base path (no segments)", async () => {
    const routes = await scanRoutes(APP_DIR);
    const docsRoute = routes.pages.find((r) => r.path.includes("docs"));
    assert.ok(docsRoute);

    const match = matchRoute("/docs", routes.pages);
    assert.ok(match, "should match /docs with optional catch-all");
    assert.deepEqual(match!.params.slug, []);
  });

  it("optional catch-all matches with segments", async () => {
    const routes = await scanRoutes(APP_DIR);
    const match = matchRoute("/docs/getting-started/intro", routes.pages);
    assert.ok(match, "should match /docs/getting-started/intro");
    assert.deepEqual(match!.params.slug, ["getting-started", "intro"]);
  });
});

describe("route scanner: URL decoding (plan §11.1, §10)", () => {
  it("decodes percent-encoded segments", async () => {
    const routes = await scanRoutes(APP_DIR);
    const match = matchRoute("/blog/hello%20world", routes.pages);
    assert.ok(match, "should match encoded path");
    assert.equal(match!.params.slug, "hello world");
  });

  it("handles malformed percent-encoding gracefully", async () => {
    const routes = await scanRoutes(APP_DIR);
    // %ZZ is not valid hex — should not throw, falls back to raw.
    const match = matchRoute("/blog/%ZZ", routes.pages);
    assert.ok(match, "should match even with malformed encoding");
    // The segment should be returned as-is (not decoded).
    assert.equal(match!.params.slug, "%ZZ");
  });
});

describe("route scanner: conflict detection (plan §11.1)", () => {
  it("throws on duplicate page routes with the same path", async () => {
    const conflictDir = join(tmpdir(), `elur-conflict-test-${Date.now()}`);
    await mkdir(join(conflictDir, "page"), { recursive: true });
    await mkdir(join(conflictDir, "(group)"), { recursive: true });
    await mkdir(join(conflictDir, "(group)", "page"), { recursive: true });

    // Both /page/page.ts and /(group)/page/page.ts resolve to /page
    await writeFile(join(conflictDir, "page", "page.ts"), "export default () => null;");
    await writeFile(join(conflictDir, "(group)", "page", "page.ts"), "export default () => null;");

    await assert.rejects(
      () => scanRoutes(conflictDir),
      /Route conflict/,
    );

    await rm(conflictDir, { recursive: true, force: true });
  });

  it("does not throw when there are no conflicts", async () => {
    const routes = await scanRoutes(APP_DIR);
    assert.ok(routes.pages.length > 0);
  });
});
