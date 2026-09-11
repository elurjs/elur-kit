import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentShell } from "../src/build/document-shell.ts";
import { buildEntrySource, buildRouterEntrySource, generateClientEntry } from "../src/island/generate-entry.ts";
import { renderPage } from "../src/ssr/render.ts";
import { scanRoutes } from "../src/router/route-scanner.ts";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureAppDir = resolve(__dirname, "fixtures/minimal/src/app");

// --- Fase 8.2/8.3/8.5/8.6: per-page JS gating, split entries, modulepreload ---

describe("documentShell: JS emission", () => {
  it("emits no scripts at all for a bare page", () => {
    const html = documentShell({ body: "<p>hi</p>" });
    assert.ok(!html.includes('type="module"'), "no module scripts");
    assert.ok(!html.includes("modulepreload"), "no preloads");
    assert.ok(!html.includes("elur:render-endpoint"), "no endpoint meta");
  });

  it("emits the client entry + modulepreload when clientEntry is set", () => {
    const html = documentShell({ body: "<p>x</p>", clientEntry: "/_elur/entry-client.js" });
    assert.ok(html.includes('<script type="module" src="/_elur/entry-client.js"></script>'));
    assert.ok(html.includes('<link rel="modulepreload" href="/_elur/entry-client.js" />'));
  });

  it("emits the router chunk + preload separately when routerEntry is set", () => {
    const html = documentShell({
      body: "<p>x</p>",
      routerEntry: "/_elur/router.js",
      routerEnabled: true,
    });
    assert.ok(html.includes('<script type="module" src="/_elur/router.js"></script>'));
    assert.ok(html.includes('<link rel="modulepreload" href="/_elur/router.js" />'));
    assert.ok(!html.includes("entry-client"), "no hydration entry without islands");
  });

  it("emits both entries with their preloads on island pages in split mode", () => {
    const html = documentShell({
      body: "<p>x</p>",
      clientEntry: "/_elur/entry-client.js",
      routerEntry: "/_elur/router.js",
      routerEnabled: true,
    });
    assert.ok(html.includes('src="/_elur/entry-client.js"'));
    assert.ok(html.includes('src="/_elur/router.js"'));
    assert.ok(html.includes('modulepreload" href="/_elur/entry-client.js"'));
    assert.ok(html.includes('modulepreload" href="/_elur/router.js"'));
  });

  it("omits the render-endpoint meta when the router is disabled", () => {
    const html = documentShell({
      body: "<p>x</p>",
      renderEndpoint: false,
      routerEnabled: false,
    });
    assert.ok(!html.includes("elur:render-endpoint"));
  });

  it("emits the render-endpoint meta when the endpoint is absent and the router is on", () => {
    const html = documentShell({
      body: "<p>x</p>",
      renderEndpoint: false,
      routerEnabled: true,
    });
    assert.ok(html.includes('<meta name="elur:render-endpoint" content="off" />'));
  });

  it("emits a Speculation Rules block only when configured", () => {
    const off = documentShell({ body: "<p>x</p>" });
    assert.ok(!off.includes("speculationrules"));

    const on = documentShell({ body: "<p>x</p>", speculation: "prefetch" });
    assert.ok(on.includes('<script type="speculationrules">'));
    const json = on.match(/<script type="speculationrules">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(json, "speculation script contents");
    const rules = JSON.parse(json!) as { prefetch?: Array<{ source: string }> };
    assert.equal(rules.prefetch?.[0]?.source, "document");
  });
});

describe("renderPage: 0% JS gating on rendered output", () => {
  // The minimal fixture has no islands — the gating paths below all run on
  // rendered output (the page body contains no data-elur-island markers).
  async function renderWith(config: Record<string, unknown>): Promise<string> {
    const routes = await scanRoutes(fixtureAppDir);
    const route = routes.pages.find((r) => r.path === "/")!;
    const result = await renderPage({
      route,
      params: {},
      searchParams: new URLSearchParams(),
      config: config as never,
    });
    return result.html;
  }

  it("ships only the router chunk when there are no islands and the bundle is split", async () => {
    const html = await renderWith({
      lang: "es",
      clientEntry: "/_elur/entry-client.js",
      router: { enabled: true, entry: "/_elur/router.js" },
      js: "modern",
    });
    assert.ok(html.includes('src="/_elur/router.js"'), "router chunk");
    assert.ok(!html.includes("entry-client.js"), "no hydration entry");
  });

  it("ships the combined entry when the bundle is not split", async () => {
    const html = await renderWith({
      lang: "es",
      clientEntry: "/_elur/entry-client.js",
      router: { enabled: true },
      js: "modern",
    });
    assert.ok(html.includes('src="/_elur/entry-client.js"'), "combined entry");
    assert.ok(!html.includes("router.js"), "no separate router chunk");
  });

  it("ships 0 KB of JS when the router is disabled and there are no islands", async () => {
    const html = await renderWith({
      lang: "es",
      clientEntry: "/_elur/entry-client.js",
      router: { enabled: false },
      js: "modern",
      renderEndpoint: false,
    });
    assert.ok(!html.includes('type="module"'), "no module scripts");
    assert.ok(!html.includes("modulepreload"), "no preloads");
    assert.ok(!html.includes("elur:render-endpoint"), "no endpoint meta without a router");
  });

  it("js:'legacy' emits the combined entry unconditionally", async () => {
    const html = await renderWith({
      lang: "es",
      clientEntry: "/_elur/entry-client.js",
      router: { enabled: true, entry: "/_elur/router.js" },
      js: "legacy",
    });
    assert.ok(html.includes('src="/_elur/entry-client.js"'), "combined entry");
    assert.ok(!html.includes("/_elur/router.js\""), "no split chunk in legacy mode");
  });

  it("emits speculation rules on statically rendered pages when configured", async () => {
    const html = await renderWith({
      lang: "es",
      clientEntry: "/_elur/entry-client.js",
      router: { enabled: true, entry: "/_elur/router.js", speculation: "prefetch" },
      js: "modern",
    });
    assert.ok(html.includes('<script type="speculationrules">'));
  });
});

describe("client entry generator: router split (Fase 8.3)", () => {
  const islands = [{ name: "Counter", filePath: "/project/src/islands/Counter.ts" }];

  it("embeds the router by default (combined entry)", () => {
    const source = buildEntrySource(islands, "/project/.elur/entry-client.ts");
    assert.ok(source.includes("startClientRouter()"));
    assert.ok(source.includes("@elurjs/kit/router"));
  });

  it("is hydrate-only when the router lives in a separate module", () => {
    const source = buildEntrySource(
      islands,
      "/project/.elur/entry-client.ts",
      "@elurjs/kit/island",
      "@elurjs/kit/router",
      { enabled: true, separate: true, outFile: "/project/.elur/router.ts" },
    );
    assert.ok(!source.includes("startClientRouter"), "entry must not start the router");
    assert.ok(!source.includes("@elurjs/kit/router"), "entry must not import the router");
    assert.ok(source.includes("hydrateIslands"));
  });

  it("is hydrate-only when the router is disabled", () => {
    const source = buildEntrySource(
      islands,
      "/project/.elur/entry-client.ts",
      "@elurjs/kit/island",
      "@elurjs/kit/router",
      { enabled: false },
    );
    assert.ok(!source.includes("startClientRouter"));
    assert.ok(!source.includes("@elurjs/kit/router"));
  });

  it("bakes router flags into a combined entry", () => {
    const source = buildEntrySource(
      islands,
      "/project/.elur/entry-client.ts",
      "@elurjs/kit/island",
      "@elurjs/kit/router",
      { enabled: true, prefetch: false, morph: true },
    );
    assert.ok(source.includes('startClientRouter({"prefetch":false,"morph":true})'));
  });

  it("bakes router flags into the standalone router module", () => {
    const source = buildRouterEntrySource("@elurjs/kit/router", {
      prefetch: false,
      loadingIndicator: true,
    });
    assert.ok(source.includes('startClientRouter({"prefetch":false,"loadingIndicator":true})'));
  });

  it("hydrates immediately — no global requestIdleCallback wrapper (Fase 8.4)", () => {
    const source = buildEntrySource(islands, "/project/.elur/entry-client.ts");
    assert.ok(!source.includes("requestIdleCallback(hydrate"), "load must not be globally deferred");
    assert.ok(source.includes("hydrate();"), "entry calls hydrate() directly");
  });

  it("wires elur:before-render cleanup with the persisted-node exception", () => {
    const source = buildEntrySource(islands, "/project/.elur/entry-client.ts");
    assert.ok(source.includes('"elur:before-render"'), "listens for before-render");
    assert.ok(source.includes("data-elur-persist"), "fallback persisted query");
    assert.ok(source.includes("cleanupHydratedIslands"));
    assert.ok(source.includes('"elur:rendered"'));
  });

  it("generateClientEntry writes the router module in split mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "elur-entry-"));
    try {
      const entry = join(dir, "entry-client.ts");
      const routerFile = join(dir, "router.ts");
      await generateClientEntry({
        islands,
        outFile: entry,
        router: { enabled: true, separate: true, outFile: routerFile },
      });
      const entrySource = await readFile(entry, "utf8");
      assert.ok(!entrySource.includes("startClientRouter"), "entry is hydrate-only");
      const routerSource = await readFile(routerFile, "utf8");
      assert.ok(routerSource.includes("startClientRouter()"), "router module starts the router");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("generateClientEntry emits a no-op router module when the router is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "elur-entry-"));
    try {
      const entry = join(dir, "entry-client.ts");
      const routerFile = join(dir, "router.ts");
      await generateClientEntry({
        islands,
        outFile: entry,
        router: { enabled: false, separate: true, outFile: routerFile },
      });
      assert.ok(existsSync(routerFile), "router file exists so two-input configs don't break");
      const routerSource = await readFile(routerFile, "utf8");
      assert.ok(!routerSource.includes("startClientRouter("), "disabled router is a no-op module");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
