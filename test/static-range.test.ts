import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { serveStaticFile } from "../src/runtime/context.ts";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const STATIC_ROOT = join(tmpdir(), `elur-static-range-${Date.now()}`);
const CONTENT = "0123456789abcdefghij"; // 20 bytes

before(async () => {
  await mkdir(STATIC_ROOT, { recursive: true });
  await writeFile(join(STATIC_ROOT, "data.txt"), CONTENT);
});

after(async () => {
  await rm(STATIC_ROOT, { recursive: true, force: true });
});

describe("static serving range & HEAD (§8.3)", () => {
  it("advertises Accept-Ranges: bytes", async () => {
    const response = await serveStaticFile(STATIC_ROOT, "/data.txt");
    assert.equal(response!.headers.get("Accept-Ranges"), "bytes");
  });

  it("serves a single byte range with 206 and Content-Range", async () => {
    const request = new Request("http://localhost/data.txt", {
      headers: { Range: "bytes=0-4" },
    });
    const response = await serveStaticFile(STATIC_ROOT, "/data.txt", request);
    assert.equal(response!.status, 206);
    assert.equal(response!.headers.get("Content-Range"), "bytes 0-4/20");
    assert.equal(response!.headers.get("Content-Length"), "5");
    assert.equal(await response!.text(), "01234");
  });

  it("serves an open-ended range (bytes=5-)", async () => {
    const request = new Request("http://localhost/data.txt", {
      headers: { Range: "bytes=5-" },
    });
    const response = await serveStaticFile(STATIC_ROOT, "/data.txt", request);
    assert.equal(response!.status, 206);
    assert.equal(response!.headers.get("Content-Range"), "bytes 5-19/20");
    assert.equal(await response!.text(), "56789abcdefghij");
  });

  it("serves a suffix range (bytes=-5)", async () => {
    const request = new Request("http://localhost/data.txt", {
      headers: { Range: "bytes=-5" },
    });
    const response = await serveStaticFile(STATIC_ROOT, "/data.txt", request);
    assert.equal(response!.status, 206);
    assert.equal(await response!.text(), "fghij");
  });

  it("returns 416 with Content-Range for an unsatisfiable range", async () => {
    const request = new Request("http://localhost/data.txt", {
      headers: { Range: "bytes=100-200" },
    });
    const response = await serveStaticFile(STATIC_ROOT, "/data.txt", request);
    assert.equal(response!.status, 416);
    assert.equal(response!.headers.get("Content-Range"), "bytes */20");
  });

  it("returns 416 for malformed ranges", async () => {
    const request = new Request("http://localhost/data.txt", {
      headers: { Range: "bytes=abc" },
    });
    const response = await serveStaticFile(STATIC_ROOT, "/data.txt", request);
    assert.equal(response!.status, 416);
  });

  it("honours If-Range with a matching ETag", async () => {
    const full = await serveStaticFile(STATIC_ROOT, "/data.txt");
    const etag = full!.headers.get("ETag")!;
    const request = new Request("http://localhost/data.txt", {
      headers: { Range: "bytes=0-1", "If-Range": etag },
    });
    const response = await serveStaticFile(STATIC_ROOT, "/data.txt", request);
    assert.equal(response!.status, 206);
    assert.equal(await response!.text(), "01");
  });

  it("ignores Range when If-Range ETag does not match", async () => {
    const request = new Request("http://localhost/data.txt", {
      headers: { Range: "bytes=0-1", "If-Range": '"stale-etag"' },
    });
    const response = await serveStaticFile(STATIC_ROOT, "/data.txt", request);
    assert.equal(response!.status, 200);
    assert.equal(await response!.text(), CONTENT);
  });

  it("serves HEAD with headers and no body", async () => {
    const request = new Request("http://localhost/data.txt", { method: "HEAD" });
    const response = await serveStaticFile(STATIC_ROOT, "/data.txt", request);
    assert.equal(response!.status, 200);
    assert.equal(response!.headers.get("Content-Length"), String(CONTENT.length));
    assert.equal(await response!.text(), "");
  });

  it("serves HEAD on a range as 206 with no body", async () => {
    const request = new Request("http://localhost/data.txt", {
      method: "HEAD",
      headers: { Range: "bytes=0-3" },
    });
    const response = await serveStaticFile(STATIC_ROOT, "/data.txt", request);
    assert.equal(response!.status, 206);
    assert.equal(response!.headers.get("Content-Range"), "bytes 0-3/20");
    assert.equal(await response!.text(), "");
  });
});
