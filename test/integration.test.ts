import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "../src/build/build.ts";
import { createSsrServer } from "../src/ssr/server.ts";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { getCachedHtml } from "../src/cache.ts";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "fixtures/minimal");
const appDir = resolve(root, "src/app");
const outDir = resolve(root, "dist");
const islandsDir = resolve(root, "src/islands");
const publicDir = resolve(root, ".tmp-public");
const secretPath = resolve(root, "secret.txt");

/** Strip Elur hydration markers so content assertions work with marker-enabled SSR. */
function stripMarkers(html: string): string {
  return html.replace(/<!--elur-\d+-->/g, "").replace(/<!--elur-end-\d+-->/g, "");
}

function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolveRequest({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("integration: build + SSR", () => {
  after(async () => {
    await rm(outDir, { recursive: true, force: true });
    await rm(publicDir, { recursive: true, force: true });
    await rm(secretPath, { force: true });
  });

  it("builds static pages from the fixture", async () => {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    const result = await build({
      appDir,
      outDir,
      islandsDir,
      generatedEntry: resolve(root, ".elur/entry-client.ts"),
      hydrateImport: "../../../src/island/index.ts",
    });

    assert.equal(result.pages, 1, "should generate one static page (home)");
    assert.equal(result.files[0], resolve(outDir, "index.html"));

    const html = await readFile(resolve(outDir, "index.html"), "utf8");
    assert.ok(stripMarkers(html).includes("<h1>Hello from test</h1>"), "should render loader data");
    assert.ok(html.includes('id="elur-data"'), "should serialize loader data");
  });

  it("copies public assets into the build output", async () => {
    await rm(outDir, { recursive: true, force: true });
    await rm(publicDir, { recursive: true, force: true });
    await mkdir(resolve(publicDir, "assets"), { recursive: true });
    await writeFile(resolve(publicDir, "assets/site.txt"), "public-asset", "utf8");

    await build({ appDir, outDir, publicDir });

    assert.equal(await readFile(resolve(outDir, "assets/site.txt"), "utf8"), "public-asset");
  });

  it("serves SSR requests and actions", async () => {
    await writeFile(secretPath, "outside-public-root", "utf8");
    const server = await createSsrServer({
      appDir,
      publicDir: outDir,
      port: 0,
    });
    await server.listen();
    const { port } = server.server.address() as { port: number };

    try {
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200);
      const body = await page.text();
      assert.ok(stripMarkers(body).includes("<h1>Hello from test</h1>"), "SSR should render home page");

      const action = await fetch(`http://127.0.0.1:${port}/__elur-js/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ name: "greet", page: "/", args: ["Ada"] }),
      });
      assert.equal(action.status, 200);
      assert.equal(await action.json(), "Hello, Ada!");

      const crossOriginAction = await fetch(`http://127.0.0.1:${port}/__elur-js/actions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: "https://evil.example.com",
        },
        body: JSON.stringify({ name: "greet", page: "/", args: ["Mallory"] }),
      });
      assert.equal(crossOriginAction.status, 403);

      const traversal = await rawGet(port, "/../secret.txt");
      assert.notEqual(traversal.status, 200);
      assert.ok(!traversal.body.includes("outside-public-root"));

      const api = await fetch(`http://127.0.0.1:${port}/api/posts`);
      assert.equal(api.status, 200);
      assert.deepEqual(await api.json(), [{ id: 1, title: "Hello" }]);

      const apiPost = await fetch(`http://127.0.0.1:${port}/api/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New" }),
      });
      assert.equal(apiPost.status, 201);
      assert.deepEqual(await apiPost.json(), { id: 2, title: "New" });

      // Cookies must be forwarded to API routes (used by auth/middleware).
      const cookieApi = await fetch(`http://127.0.0.1:${port}/api/posts`, {
        headers: { Cookie: "session=test-session-123" },
      });
      assert.equal(cookieApi.status, 200);
    } finally {
      await server.close();
    }
  });

  it("caches streamed content via the render endpoint with ISR", async () => {
    const cacheDir = resolve(root, ".elur/cache-render");
    await rm(cacheDir, { recursive: true, force: true });
    const server = await createSsrServer({
      appDir,
      cacheDir,
      defaultRevalidate: 60,
      port: 0,
    });
    await server.listen();
    const { port } = server.server.address() as { port: number };

    try {
      const render = await fetch(`http://127.0.0.1:${port}/__elur-js/render?page=%2F&search=`);
      assert.equal(render.status, 200);
      const cached = await getCachedHtml(cacheDir, "/__elur-js/render/?");
      assert.ok(cached, "render endpoint content should be cached");
      assert.ok(stripMarkers(cached.html).includes("<h1>Hello from test</h1>"), "cached HTML should match");
    } finally {
      await server.close();
    }
  });

  it("caches pages with revalidate in ISR cache", async () => {
    const cacheDir = resolve(root, ".elur/cache");
    await rm(cacheDir, { recursive: true, force: true });
    const server = await createSsrServer({
      appDir,
      cacheDir,
      streaming: false,
      port: 0,
    });
    await server.listen();
    const { port } = server.server.address() as { port: number };

    try {
      const privatePage = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { Cookie: "session=private-user" },
      });
      assert.equal(privatePage.status, 200);
      assert.equal(await getCachedHtml(cacheDir, "/"), undefined);

      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200);
      const body = await page.text();
      assert.ok(stripMarkers(body).includes("<h1>Hello from test</h1>"), "SSR should render home page");

      const cached = await getCachedHtml(cacheDir, "/");
      assert.ok(cached, "page should be cached");
      assert.ok(stripMarkers(cached.html).includes("<h1>Hello from test</h1>"), "cached HTML should match");
      assert.equal(cached.revalidate, 60, "revalidate should be 60 seconds");
    } finally {
      await server.close();
    }
  });

  it("streams loading boundary and renders real content via endpoint", async () => {
    const server = await createSsrServer({
      appDir,
      streaming: true,
      port: 0,
    });
    await server.listen();
    const { port } = server.server.address() as { port: number };

    try {
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200);
      const body = await page.text();
      assert.ok(body.includes("<p>Loading...</p>"), "shell should render loading boundary");
      assert.ok(body.includes("__elurJsStreamRender"), "shell should include streaming script");

      const render = await fetch(`http://127.0.0.1:${port}/__elur-js/render?page=%2F&search=`);
      assert.equal(render.status, 200);
      const renderedBody = await render.text();
      assert.ok(stripMarkers(renderedBody).includes("<h1>Hello from test</h1>"), "render endpoint should return real content");
    } finally {
      await server.close();
    }
  });
});
