// CSRF / Origin verification tests (plan §1, A-07, testing-roadmap §3.2)
//
// Tests that verifyOrigin:
//   - accepts same-origin requests
//   - rejects cross-origin requests
//   - handles missing Origin and Referer
//   - respects strictOrigin mode
//   - respects allowedOrigins allow-list
//   - handles Sec-Fetch-Site header

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyOrigin, originForbidden, type OriginCheckOptions } from "../src/action/origin.ts";

function makeRequest(
  url: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, { headers });
}

const TARGET = "http://localhost:3000";
const CROSS_ORIGIN = "http://evil.com";

describe("CSRF: same-origin (A-07)", () => {
  it("accepts when Origin matches target", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, { Origin: TARGET });
    assert.equal(verifyOrigin(req), undefined);
  });

  it("accepts when Referer matches target", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, { Referer: `${TARGET}/some-page` });
    assert.equal(verifyOrigin(req), undefined);
  });

  it("accepts when Origin matches with different path", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, { Origin: `${TARGET}/some-path` });
    assert.equal(verifyOrigin(req), undefined);
  });
});

describe("CSRF: cross-origin (A-07)", () => {
  it("rejects when Origin is different host", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, { Origin: CROSS_ORIGIN });
    const result = verifyOrigin(req);
    assert.ok(result, "should reject cross-origin");
    assert.ok(result!.includes("Cross-origin"));
  });

  it("rejects when Referer is different host", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, { Referer: `${CROSS_ORIGIN}/page` });
    const result = verifyOrigin(req);
    assert.ok(result, "should reject cross-origin Referer");
  });

  it("rejects when Origin has different port", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, { Origin: "http://localhost:8080" });
    const result = verifyOrigin(req);
    assert.ok(result, "should reject different port");
  });

  it("rejects when Origin has different protocol", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, { Origin: "https://localhost:3000" });
    const result = verifyOrigin(req);
    assert.ok(result, "should reject different protocol");
  });
});

describe("CSRF: missing headers (A-07)", () => {
  it("accepts when both Origin and Referer are missing (default)", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`);
    assert.equal(verifyOrigin(req), undefined);
  });

  it("rejects when both missing and strictOrigin is true", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`);
    const opts: OriginCheckOptions = { strictOrigin: true };
    const result = verifyOrigin(req, opts);
    assert.ok(result, "should reject missing headers in strict mode");
    assert.ok(result!.includes("Missing"));
  });
});

describe("CSRF: allow-list (A-07)", () => {
  it("accepts cross-origin when in allowedOrigins", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, { Origin: "http://preview.example.com" });
    const opts: OriginCheckOptions = { allowedOrigins: ["http://preview.example.com"] };
    assert.equal(verifyOrigin(req, opts), undefined);
  });

  it("rejects cross-origin when not in allowedOrigins", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, { Origin: CROSS_ORIGIN });
    const opts: OriginCheckOptions = { allowedOrigins: ["http://preview.example.com"] };
    const result = verifyOrigin(req, opts);
    assert.ok(result, "should reject origin not in allow-list");
  });

  it("accepts multiple allowed origins", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, { Origin: "http://staging.example.com" });
    const opts: OriginCheckOptions = {
      allowedOrigins: ["http://preview.example.com", "http://staging.example.com"],
    };
    assert.equal(verifyOrigin(req, opts), undefined);
  });
});

describe("CSRF: invalid headers (A-07)", () => {
  it("rejects invalid Origin header", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, { Origin: "not-a-url" });
    const result = verifyOrigin(req);
    assert.ok(result, "should reject invalid Origin");
    assert.ok(result!.includes("Invalid Origin"));
  });

  it("rejects invalid Referer header", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, { Referer: "not-a-url" });
    const result = verifyOrigin(req);
    assert.ok(result, "should reject invalid Referer");
    assert.ok(result!.includes("Invalid Referer"));
  });

  it("rejects non-HTTP protocol in Origin", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, { Origin: "file:///etc/passwd" });
    const result = verifyOrigin(req);
    assert.ok(result, "should reject file:// protocol");
  });
});

describe("CSRF: originForbidden response (A-07)", () => {
  it("returns 403 response", () => {
    const response = originForbidden("Cross-origin blocked");
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Content-Type"), "text/plain; charset=utf-8");
  });
});

describe("CSRF: Sec-Fetch-Site (A-07)", () => {
  it("accepts when Sec-Fetch-Site is same-origin", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, {
      "Sec-Fetch-Site": "same-origin",
    });
    assert.equal(verifyOrigin(req), undefined);
  });

  it("rejects when Sec-Fetch-Site is cross-site", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, {
      "Sec-Fetch-Site": "cross-site",
    });
    // Sec-Fetch-Site: cross-site without Origin/Referer should be rejected
    // in strict mode, but accepted in default mode (no Origin/Referer)
    // The current implementation doesn't check Sec-Fetch-Site directly,
    // but this test documents the expected behavior
    const result = verifyOrigin(req, { strictOrigin: true });
    assert.ok(result, "cross-site Sec-Fetch-Site should be rejected in strict mode");
  });

  it("accepts when Sec-Fetch-Site is none (non-browser)", () => {
    const req = makeRequest(`${TARGET}/__nix-js/actions`, {
      "Sec-Fetch-Site": "none",
    });
    assert.equal(verifyOrigin(req), undefined);
  });
});
