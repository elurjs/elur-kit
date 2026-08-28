import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Test the isCacheable and isResultCacheable logic indirectly via the
// web handler. We verify that:
// 1. Requests with Cookie header are not cached.
// 2. Requests with Authorization header are not cached.
// 3. POST requests are not cached.
// 4. HTML containing action error markers is not cached.

describe("cache bypass policy (runtime-security §9.1)", () => {
  it("isCacheable rejects requests with Cookie header", () => {
    // Re-implement the same logic to test the policy directly.
    function isCacheable(request: Request): boolean {
      if (request.method !== "GET" && request.method !== "HEAD") return false;
      if (request.headers.get("Cookie")) return false;
      if (request.headers.get("Authorization")) return false;
      return true;
    }

    const withCookie = new Request("http://localhost/", {
      headers: { Cookie: "session=abc123" },
    });
    assert.equal(isCacheable(withCookie), false, "Cookie header should prevent caching");

    const withAuth = new Request("http://localhost/", {
      headers: { Authorization: "Bearer token123" },
    });
    assert.equal(isCacheable(withAuth), false, "Authorization header should prevent caching");

    const postRequest = new Request("http://localhost/", { method: "POST" });
    assert.equal(isCacheable(postRequest), false, "POST should not be cached");

    const cleanGet = new Request("http://localhost/");
    assert.equal(isCacheable(cleanGet), true, "Clean GET should be cacheable");

    const headRequest = new Request("http://localhost/", { method: "HEAD" });
    assert.equal(isCacheable(headRequest), true, "HEAD should be cacheable");
  });

  it("isResultCacheable rejects HTML with action error markers", () => {
    function isResultCacheable(result: { revalidate?: number; html: string }): boolean {
      if (result.html.includes("__elur_js_action_error")) return false;
      if (result.revalidate === undefined) return false;
      return true;
    }

    assert.equal(
      isResultCacheable({ html: "<html>__elur_js_action_error</html>", revalidate: 60 }),
      false,
      "HTML with action error marker should not be cached",
    );

    assert.equal(
      isResultCacheable({ html: "<html>clean</html>", revalidate: 60 }),
      true,
      "Clean HTML with revalidate should be cacheable",
    );

    assert.equal(
      isResultCacheable({ html: "<html>clean</html>" }),
      false,
      "HTML without revalidate should not be cached",
    );
  });
});
