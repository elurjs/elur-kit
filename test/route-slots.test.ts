import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { scanRoutes } from "../src/router/route-scanner.ts";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const APP_DIR = join(tmpdir(), `elur-slots-test-${Date.now()}`);

async function setupApp(baseDir: string, structure: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(structure)) {
    const fullPath = join(baseDir, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
}

before(async () => {
  await mkdir(APP_DIR, { recursive: true });
});

after(async () => {
  await rm(APP_DIR, { recursive: true, force: true });
});

// Fix #2: Route Groups + Layout Slots

describe("Fix #2: Route Groups", () => {
  it("route groups do not add URL segments", async () => {
    const dir = join(APP_DIR, "groups-basic");
    await setupApp(dir, {
      "(marketing)/page.ts": "export default () => null;",
      "(marketing)/about/page.ts": "export default () => null;",
      "(shop)/products/page.ts": "export default () => null;",
    });
    const routes = await scanRoutes(dir);
    assert.ok(routes.pages.some((p) => p.path === "/"), "root page in (marketing) group");
    assert.ok(routes.pages.some((p) => p.path === "/about"), "/about page in (marketing) group");
    assert.ok(routes.pages.some((p) => p.path === "/products"), "/products page in (shop) group");
  });

  it("route groups can add layouts without affecting URL", async () => {
    const dir = join(APP_DIR, "groups-layout");
    await setupApp(dir, {
      "(marketing)/layout.ts": "export default ({ children }) => children;",
      "(marketing)/page.ts": "export default () => null;",
      "(shop)/layout.ts": "export default ({ children }) => children;",
      "(shop)/products/page.ts": "export default () => null;",
    });
    const routes = await scanRoutes(dir);
    const home = routes.pages.find((p) => p.path === "/");
    const products = routes.pages.find((p) => p.path === "/products");
    assert.ok(home, "home page exists");
    assert.ok(home!.layouts.some((l) => l.includes("(marketing)")), "home has marketing layout");
    assert.ok(products, "products page exists");
    assert.ok(products!.layouts.some((l) => l.includes("(shop)")), "products has shop layout");
  });
});

describe("Fix #2: Layout Slots", () => {
  it("detects *.slot.ts files and maps them to named slots", async () => {
    const dir = join(APP_DIR, "slots-basic");
    await setupApp(dir, {
      "page.ts": "export default () => null;",
      "sidebar.slot.ts": "export default () => null;",
      "header.slot.ts": "export default () => null;",
    });
    const routes = await scanRoutes(dir);
    const page = routes.pages.find((p) => p.path === "/");
    assert.ok(page, "page exists");
    assert.ok(page!.slots, "page has slots");
    assert.ok(page!.slots!["sidebar"], "sidebar slot detected");
    assert.ok(page!.slots!["header"], "header slot detected");
  });

  it("pages without slot files have undefined slots", async () => {
    const dir = join(APP_DIR, "no-slots");
    await setupApp(dir, {
      "page.ts": "export default () => null;",
    });
    const routes = await scanRoutes(dir);
    const page = routes.pages.find((p) => p.path === "/");
    assert.ok(page, "page exists");
    assert.equal(page!.slots, undefined, "no slots property when no slot files");
  });

  it("slots are detected in nested directories", async () => {
    const dir = join(APP_DIR, "slots-nested");
    await setupApp(dir, {
      "blog/page.ts": "export default () => null;",
      "blog/comments.slot.ts": "export default () => null;",
    });
    const routes = await scanRoutes(dir);
    const page = routes.pages.find((p) => p.path === "/blog");
    assert.ok(page, "blog page exists");
    assert.ok(page!.slots?.["comments"], "comments slot detected in nested dir");
  });
});
