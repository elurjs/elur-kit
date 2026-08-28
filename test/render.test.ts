import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanRoutes } from "../src/router/route-scanner.ts";
import { scanActions } from "../src/action/scan.ts";
import { renderPage } from "../src/ssr/render.ts";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, "fixtures/minimal/src/app");

/** Strip Elur hydration markers so content assertions work with marker-enabled SSR. */
function stripMarkers(html: string): string {
  return html.replace(/<!--elur-\d+-->/g, "").replace(/<!--elur-end-\d+-->/g, "");
}

describe("renderPage", () => {
  it("renders the home page with loader data", async () => {
    const routes = await scanRoutes(appDir);
    const actions = await scanActions(appDir);
    const home = routes.pages.find((p) => p.path === "/")!;
    const { html } = await renderPage({
      route: home,
      config: { clientEntry: "/_elur/entry-client.js", lang: "es" },
      actions,
    });
    assert.ok(stripMarkers(html).includes("<h1>Hello from test</h1>"), "should render loader data");
    assert.ok(html.includes('id="elur-data"'), "should serialize loader data");
    assert.ok(html.includes('id="elur-actions"'), "should include actions registry");
  });

  it("renders dynamic route params", async () => {
    const routes = await scanRoutes(appDir);
    const actions = await scanActions(appDir);
    const blog = routes.pages.find((p) => p.path === "/blog/:slug")!;
    const { html } = await renderPage({
      route: blog,
      params: { slug: "hello-world" },
      config: { clientEntry: "/_elur/entry-client.js", lang: "es" },
      actions,
    });
    assert.ok(stripMarkers(html).includes("<h1>Post: hello-world</h1>"), "should render dynamic loader data");
    assert.ok(stripMarkers(html).includes("<p>hello-world</p>"), "should render params");
  });
});
