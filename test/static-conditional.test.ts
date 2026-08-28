import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { serveStaticFile } from "../src/runtime/context.ts";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const STATIC_ROOT = join(tmpdir(), `elur-static-test-${Date.now()}`);

before(async () => {
  await mkdir(STATIC_ROOT, { recursive: true });
  await writeFile(join(STATIC_ROOT, "index.html"), "<h1>Hello</h1>");
  await writeFile(join(STATIC_ROOT, "app-abc123def.js"), "console.log(1)");
  await writeFile(join(STATIC_ROOT, "style.css"), "body { color: red; }");
});

after(async () => {
  await rm(STATIC_ROOT, { recursive: true, force: true });
});

describe("static serving conditional requests (§7.2)", () => {
  it("returns ETag and Last-Modified headers", async () => {
    const response = await serveStaticFile(STATIC_ROOT, "/index.html");
    assert.ok(response, "should return a response");
    assert.ok(response!.headers.get("ETag"), "should have ETag");
    assert.ok(response!.headers.get("Last-Modified"), "should have Last-Modified");
    assert.equal(response!.headers.get("Content-Type"), "text/html; charset=utf-8");
  });

  it("returns 304 when If-None-Match matches ETag", async () => {
    const first = await serveStaticFile(STATIC_ROOT, "/index.html");
    const etag = first!.headers.get("ETag")!;
    const request = new Request("http://localhost/index.html", {
      headers: { "If-None-Match": etag },
    });
    const response = await serveStaticFile(STATIC_ROOT, "/index.html", request);
    assert.equal(response!.status, 304);
    assert.equal(response!.headers.get("ETag"), etag);
    assert.ok(!response!.body, "304 should have no body");
  });

  it("returns 200 when If-None-Match does not match", async () => {
    const request = new Request("http://localhost/index.html", {
      headers: { "If-None-Match": '"different-etag"' },
    });
    const response = await serveStaticFile(STATIC_ROOT, "/index.html", request);
    assert.equal(response!.status, 200);
  });

  it("returns 304 when If-Modified-Since is newer than mtime", async () => {
    const first = await serveStaticFile(STATIC_ROOT, "/index.html");
    const lastModified = first!.headers.get("Last-Modified")!;
    const request = new Request("http://localhost/index.html", {
      headers: { "If-Modified-Since": lastModified },
    });
    const response = await serveStaticFile(STATIC_ROOT, "/index.html", request);
    assert.equal(response!.status, 304);
  });

  it("returns 200 when If-Modified-Since is older than mtime", async () => {
    const request = new Request("http://localhost/index.html", {
      headers: { "If-Modified-Since": "Thu, 01 Jan 1970 00:00:00 GMT" },
    });
    const response = await serveStaticFile(STATIC_ROOT, "/index.html", request);
    assert.equal(response!.status, 200);
  });

  it("sets immutable Cache-Control for hashed assets", async () => {
    const response = await serveStaticFile(STATIC_ROOT, "/app-abc123def.js");
    const cc = response!.headers.get("Cache-Control");
    assert.ok(cc!.includes("immutable"), "hashed asset should have immutable cache-control");
    assert.ok(cc!.includes("max-age=31536000"), "should have 1-year max-age");
  });

  it("sets must-revalidate for non-hashed files", async () => {
    const response = await serveStaticFile(STATIC_ROOT, "/index.html");
    const cc = response!.headers.get("Cache-Control");
    assert.ok(cc!.includes("must-revalidate"), "non-hashed file should have must-revalidate");
  });

  it("includes Content-Length", async () => {
    const response = await serveStaticFile(STATIC_ROOT, "/index.html");
    const cl = response!.headers.get("Content-Length");
    assert.ok(cl, "should have Content-Length");
    assert.equal(parseInt(cl!, 10), "<h1>Hello</h1>".length);
  });
});
