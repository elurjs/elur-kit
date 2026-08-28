import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toPublicErrorInfo, publicErrorResponse } from "../src/errors.ts";

describe("public error sanitization (§8.4)", () => {
  it("never leaks the internal error message by default", () => {
    const error = new Error("Sensitive path: /home/user/.elur/secret/stack trace");
    const info = toPublicErrorInfo(error);
    assert.equal(info.message, "Internal Server Error");
    assert.equal(info.code, "INTERNAL_SERVER_ERROR");
    assert.equal(info.status, 500);
  });

  it("never includes the stack trace", () => {
    const error = new Error("boom");
    error.stack = "at /internal/path (file:///secret/app.ts:1:1)";
    const info = toPublicErrorInfo(error);
    assert.ok(!info.message.includes("file://"));
    assert.ok(!info.message.includes("at "));
  });

  it("handles non-Error thrown values", () => {
    const info = toPublicErrorInfo("raw string leak");
    assert.equal(info.message, "Internal Server Error");
  });

  it("produces a JSON 500 response with no-store", async () => {
    const response = publicErrorResponse(new Error("secret message"), { requestId: "req-1" });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Request-Id"), "req-1");
    assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
    const body = (await response.json()) as { error: { message: string } };
    assert.equal(body.error.message, "Internal Server Error");
  });

  it("includes detail only when explicitly requested (dev)", () => {
    const error = new Error("dev detail");
    const info = toPublicErrorInfo(error, { includeDetail: true });
    assert.equal(info.message, "dev detail");
  });

  it("returns a stable machine-readable body", async () => {
    const response = publicErrorResponse(new Error("x"));
    const body = (await response.json()) as { error: { code: string; message: string; status: number } };
    assert.deepEqual(body.error, { code: "INTERNAL_SERVER_ERROR", message: "Internal Server Error", status: 500 });
  });
});
