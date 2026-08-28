import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebHandler } from "../src/runtime/handler.ts";
import { guessContentType, htmlResponse, jsonResponse, textResponse, notFound, methodNotAllowed, serverError } from "../src/runtime/context.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tempRoot = resolve(__dirname, "fixtures/minimal/.tmp-web-handler");

describe("runtime: response helpers", () => {
  it("htmlResponse sets content-type and status", () => {
    const res = htmlResponse("<h1>hi</h1>", 200);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
  });

  it("jsonResponse serializes JSON", async () => {
    const res = jsonResponse({ ok: true });
    assert.equal(res.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(await res.text()), { ok: true });
  });

  it("textResponse sets text/plain", () => {
    const res = textResponse("hello");
    assert.equal(res.headers.get("Content-Type"), "text/plain; charset=utf-8");
  });

  it("notFound returns 404", () => {
    const res = notFound("missing");
    assert.equal(res.status, 404);
  });

  it("methodNotAllowed returns 405", () => {
    const res = methodNotAllowed("PUT");
    assert.equal(res.status, 405);
    assert.ok((res.headers.get("Content-Type") ?? "").includes("text/plain"));
  });

  it("serverError returns 500", () => {
    const res = serverError("boom");
    assert.equal(res.status, 500);
  });
});

describe("runtime: guessContentType", () => {
  it("maps common extensions", () => {
    assert.equal(guessContentType("index.html"), "text/html; charset=utf-8");
    assert.equal(guessContentType("style.css"), "text/css; charset=utf-8");
    assert.equal(guessContentType("app.js"), "application/javascript; charset=utf-8");
    assert.equal(guessContentType("data.json"), "application/json; charset=utf-8");
    assert.equal(guessContentType("logo.svg"), "image/svg+xml");
    assert.equal(guessContentType("photo.webp"), "image/webp");
    assert.equal(guessContentType("font.woff2"), "font/woff2");
  });

  it("falls back to octet-stream for unknown", () => {
    assert.equal(guessContentType("file.xyz"), "application/octet-stream");
  });
});

describe("runtime: createWebHandler static files", () => {
  const staticRoot = join(tempRoot, "static");

  before(async () => {
    await mkdir(staticRoot, { recursive: true });
    await writeFile(join(staticRoot, "index.html"), "<h1>static home</h1>", "utf8");
    await writeFile(join(staticRoot, "style.css"), "body{}", "utf8");
    await mkdir(join(staticRoot, "sub"), { recursive: true });
    await writeFile(join(staticRoot, "sub", "page.html"), "<p>sub page</p>", "utf8");
  });

  after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const handler = createWebHandler(
    { pages: [], api: [] },
    {},
    { staticRoot },
  );

  it("serves index.html from root", async () => {
    const res = await handler(new Request("http://localhost/"));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes("<h1>static home</h1>"));
  });

  it("serves a CSS file with correct content-type", async () => {
    const res = await handler(new Request("http://localhost/style.css"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/css; charset=utf-8");
  });

  it("serves nested HTML files", async () => {
    const res = await handler(new Request("http://localhost/sub/page.html"));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes("<p>sub page</p>"));
  });

  it("returns 404 for missing static files (no routes)", async () => {
    const res = await handler(new Request("http://localhost/nonexistent.html"));
    assert.equal(res.status, 404);
  });

  it("rejects path traversal attempts", async () => {
    const res = await handler(new Request("http://localhost/../../etc/passwd"));
    assert.equal(res.status, 404);
  });

  it("rejects encoded path traversal", async () => {
    const res = await handler(new Request("http://localhost/%2e%2e%2f%2e%2e%2fetc%2fpasswd"));
    assert.equal(res.status, 404);
  });
});

describe("runtime: createWebHandler no-cache mode", () => {
  const staticRoot = join(tempRoot, "nocache");

  before(async () => {
    await mkdir(staticRoot, { recursive: true });
    await writeFile(
      join(staticRoot, "index.html"),
      '<html><meta name="elur:render-endpoint" content="off" /><body>hi</body></html>',
      "utf8",
    );
  });

  after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("strips render-endpoint marker and sets no-store in dev mode", async () => {
    const handler = createWebHandler(
      { pages: [], api: [] },
      {},
      { staticRoot, noCache: true },
    );
    const res = await handler(new Request("http://localhost/"));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(!body.includes('elur:render-endpoint'), "should strip the marker");
    assert.equal(res.headers.get("Cache-Control"), "no-store, must-revalidate");
  });
});
