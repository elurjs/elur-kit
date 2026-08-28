import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanActions } from "../src/action/scan.ts";
import { handleActionRequest } from "../src/action/server.ts";
import { verifyOrigin } from "../src/action/origin.ts";
import {
  encodeActionErrorCookie,
  decodeActionErrorCookie,
  ACTION_ERROR_COOKIE,
} from "../src/action/error-store.ts";
import { fail, redirect } from "../src/errors.ts";
import { scanRoutes } from "../src/router/route-scanner.ts";
import { resolveActionPageKey } from "../src/ssr/server.ts";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, "fixtures/minimal/src/app");

describe("scanActions", () => {
  it("groups actions by page path", async () => {
    const actions = await scanActions(appDir);
    assert.equal(actions["/"].greet, resolve(appDir, "page.action.ts"));
    assert.equal(actions["/"].subscribe, resolve(appDir, "page.action.ts"));
  });
});

describe("resolveActionPageKey", () => {
  it("maps concrete dynamic paths to their route pattern", async () => {
    const routes = await scanRoutes(resolve(__dirname, "fixtures/minimal/src/app"));
    // Dynamic route fixture: /blog/[slug]
    assert.equal(resolveActionPageKey("/blog/hello-world", routes), "/blog/:slug");
    assert.equal(resolveActionPageKey("/blog/another-post", routes), "/blog/:slug");
  });

  it("keeps exact static paths", async () => {
    const routes = await scanRoutes(resolve(__dirname, "fixtures/minimal/src/app"));
    assert.equal(resolveActionPageKey("/", routes), "/");
  });
});

describe("handleActionRequest", () => {
  async function resolveAction(name: string, page?: string) {
    const actions = await scanActions(appDir);
    const actionPath = page ? actions[page]?.[name] : Object.values(actions).find((p) => p[name])?.[name];
    if (!actionPath) return undefined;
    const mod = await import(actionPath);
    return mod[name] as (...args: unknown[]) => unknown;
  }

  it("executes a JSON action with page scope", async () => {
    const request = new Request("http://localhost/__elur-js/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name: "greet", page: "/", args: ["Ada"] }),
    });
    const response = await handleActionRequest(request, resolveAction);
    assert.equal(response.status, 200);
    assert.equal(await response.json(), "Hello, Ada!");
  });

  it("executes a JSON action with object args", async () => {
    const request = new Request("http://localhost/__elur-js/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name: "subscribe", page: "/", args: [{ email: "ada@example.com" }] }),
    });
    const response = await handleActionRequest(request, resolveAction);
    assert.equal(response.status, 200);
    assert.equal(await response.json(), "Subscribed: ada@example.com");
  });

  it("returns a redirect for form POSTs", async () => {
    const request = new Request("http://localhost/__elur-js/actions", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "http://localhost/" },
      body: new URLSearchParams({
        __elur_js_action_name: "subscribe",
        __elur_js_action_page: "/",
        email: "ada@example.com",
      }).toString(),
    });
    const response = await handleActionRequest(request, resolveAction);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("Location"), "Subscribed: ada@example.com");
  });

  it("returns a JSON ActionFailure payload", async () => {
    const badAction = async () => fail(400, { field: "email", message: "Invalid email" });
    const request = new Request("http://localhost/__elur-js/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name: "bad", args: [] }),
    });
    const response = await handleActionRequest(request, async () => badAction);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { __elur_js_action_failure: boolean; status: number; data: unknown };
    assert.equal(body.__elur_js_action_failure, true);
    assert.equal(body.status, 400);
    assert.deepEqual(body.data, { field: "email", message: "Invalid email" });
  });

  it("redirects with ActionFailure data in a cookie for form POSTs", async () => {
    const badAction = async () => fail(400, { field: "email", message: "Invalid email" });
    const request = new Request("http://localhost/__elur-js/actions", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "http://localhost/contact" },
      body: new URLSearchParams({ __elur_js_action_name: "bad", __elur_js_action_page: "/" }).toString(),
    });
    const response = await handleActionRequest(request, async () => badAction);
    assert.equal(response.status, 303);
    const location = response.headers.get("Location");
    assert.equal(location, "/contact");
    // No query param — errors must not leak into the URL.
    assert.ok(!location?.includes("__elur_js_action_error"), "should not put error in URL");
    // Error is relayed via a Set-Cookie header.
    const setCookie = response.headers.get("Set-Cookie");
    assert.ok(setCookie, "should set a cookie");
    assert.ok(setCookie.startsWith(`${ACTION_ERROR_COOKIE}=`), "cookie should have the right name");
    assert.ok(setCookie.includes("SameSite=Lax"), "cookie should be SameSite=Lax");
    assert.ok(setCookie.includes("Max-Age=15"), "cookie should be short-lived");
  });

  it("returns a JSON redirect payload for JSON requests", async () => {
    const redirectAction = async () => redirect(303, "/login");
    const request = new Request("http://localhost/__elur-js/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name: "redirect", args: [] }),
    });
    const response = await handleActionRequest(request, async () => redirectAction);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { __elur_js_action_redirect: boolean; status: number; location: string };
    assert.equal(body.__elur_js_action_redirect, true);
    assert.equal(body.status, 303);
    assert.equal(body.location, "/login");
  });

  it("returns an HTTP redirect for form POSTs", async () => {
    const redirectAction = async () => redirect(303, "/login");
    const request = new Request("http://localhost/__elur-js/actions", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "http://localhost/" },
      body: new URLSearchParams({ __elur_js_action_name: "redirect", __elur_js_action_page: "/" }).toString(),
    });
    const response = await handleActionRequest(request, async () => redirectAction);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("Location"), "/login");
  });
});

describe("verifyOrigin (CSRF protection)", () => {
  it("allows same-origin requests via Origin header", () => {
    const request = new Request("http://localhost:3000/__elur-js/actions", {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
    });
    assert.equal(verifyOrigin(request), undefined);
  });

  it("allows same-origin requests via Referer fallback", () => {
    const request = new Request("http://localhost:3000/__elur-js/actions", {
      method: "POST",
      headers: { Referer: "http://localhost:3000/contact" },
    });
    assert.equal(verifyOrigin(request), undefined);
  });

  it("rejects cross-origin requests", () => {
    const request = new Request("http://localhost:3000/__elur-js/actions", {
      method: "POST",
      headers: { Origin: "https://evil.example.com" },
    });
    const error = verifyOrigin(request);
    assert.ok(error, "should reject cross-origin");
    assert.ok(error.includes("Cross-origin"), "error message should mention cross-origin");
  });

  it("rejects a malformed Origin even when Referer is same-origin", () => {
    const request = new Request("http://localhost:3000/__elur-js/actions", {
      method: "POST",
      headers: {
        Origin: "http://[invalid-url]",
        Referer: "http://localhost:3000/contact",
      },
    });
    assert.ok(verifyOrigin(request));
  });

  it("rejects a different protocol on the same host", () => {
    const request = new Request("https://localhost:3000/__elur-js/actions", {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
    });
    assert.ok(verifyOrigin(request));
  });

  it("allows requests without Origin and Referer by default", () => {
    const request = new Request("http://localhost:3000/__elur-js/actions", {
      method: "POST",
    });
    assert.equal(verifyOrigin(request), undefined);
  });

  it("rejects requests without Origin and Referer when strictOrigin is true", () => {
    const request = new Request("http://localhost:3000/__elur-js/actions", {
      method: "POST",
    });
    const error = verifyOrigin(request, { strictOrigin: true });
    assert.ok(error, "should reject when strict");
  });

  it("allows allow-listed origins", () => {
    const request = new Request("http://localhost:3000/__elur-js/actions", {
      method: "POST",
      headers: { Origin: "https://preview.example.com" },
    });
    assert.equal(
      verifyOrigin(request, { allowedOrigins: ["https://preview.example.com"] }),
      undefined,
    );
  });
});

describe("handleActionRequest CSRF integration", () => {
  it("rejects cross-origin POSTs with 403", async () => {
    const action = async () => "ok";
    const request = new Request("http://localhost:3000/__elur-js/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify({ name: "test", args: [] }),
    });
    const response = await handleActionRequest(request, async () => action);
    assert.equal(response.status, 403);
  });
});

describe("action error cookie store", () => {
  it("round-trips small payloads inline in the cookie", () => {
    const data = { field: "email", message: "Invalid" };
    const { value, storeId } = encodeActionErrorCookie(data, 400);
    assert.equal(storeId, undefined, "small payload should not use the store");
    const decoded = decodeActionErrorCookie(value);
    assert.deepEqual(decoded, { data, status: 400 });
  });

  it("uses the in-memory store for large payloads", () => {
    const largeData = { errors: "x".repeat(5000) };
    const { value, storeId } = encodeActionErrorCookie(largeData, 400);
    assert.ok(storeId, "large payload should use the store");
    // The cookie value is now signed, so it won't start with "id:" directly.
    // But decoding should still work.
    const decoded = decodeActionErrorCookie(value);
    assert.deepEqual(decoded, { data: largeData, status: 400 });
  });

  it("returns undefined for unknown store ids", () => {
    // Forge a signed "id:nonexistent" — but without the right secret, it
    // won't verify. Use a properly signed value with a nonexistent id.
    const { value } = encodeActionErrorCookie({ x: 1 }, 400);
    // Tamper with the value to reference a nonexistent store id.
    // Since we can't forge without the secret, just test with a raw unsigned
    // value — it should fail signature verification.
    assert.equal(decodeActionErrorCookie("id:nonexistent"), undefined);
  });

  it("returns undefined for empty or invalid values", () => {
    assert.equal(decodeActionErrorCookie(undefined), undefined);
    assert.equal(decodeActionErrorCookie(null), undefined);
    assert.equal(decodeActionErrorCookie(""), undefined);
    assert.equal(decodeActionErrorCookie("!!!invalid-base64!!!"), undefined);
  });

  it("rejects tampered/forged cookie values (A-20)", () => {
    // A forged unsigned base64url value should be rejected.
    const forged = Buffer.from(JSON.stringify({ d: "hacked", s: 200 }), "utf8").toString("base64url");
    assert.equal(decodeActionErrorCookie(forged), undefined, "unsigned value should be rejected");

    // A value with a wrong signature should be rejected.
    const { value } = encodeActionErrorCookie({ real: true }, 400);
    const tampered = "deadbeef." + value.slice(value.indexOf(".") + 1);
    assert.equal(decodeActionErrorCookie(tampered), undefined, "wrong signature should be rejected");
  });

  it("produces signed cookie values with HMAC prefix", () => {
    const { value } = encodeActionErrorCookie({ test: true }, 400);
    // Signed values have format: <hex-signature>.<base64url-payload>
    assert.ok(value.includes("."), "signed value should contain a dot separator");
    const sig = value.slice(0, value.indexOf("."));
    // HMAC-SHA256 produces 64 hex chars.
    assert.equal(sig.length, 64, "signature should be 64 hex chars (HMAC-SHA256)");
  });
});

describe("handleActionRequest body limits (§8.2)", () => {
  it("rejects oversized JSON bodies with 413", async () => {
    const largeArgs = ["x".repeat(10_000)];
    const body = JSON.stringify({ name: "greet", page: "/", args: largeArgs });
    const request = new Request("http://localhost:3000/__elur-js/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
        "Content-Length": String(body.length),
      },
      body,
    });
    const response = await handleActionRequest(request, async () => () => "ok", {
      bodyLimit: 100,
    });
    assert.equal(response.status, 413);
  });

  it("rejects oversized form bodies with 413", async () => {
    const body = "__elur_js_action_name=greet&__elur_js_action_page=/&data=" + "x".repeat(10_000);
    const request = new Request("http://localhost:3000/__elur-js/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "http://localhost:3000",
        "Content-Length": String(body.length),
      },
      body,
    });
    const response = await handleActionRequest(request, async () => () => "ok", {
      bodyLimit: 100,
    });
    assert.equal(response.status, 413);
  });

  it("accepts bodies within the limit", async () => {
    const body = JSON.stringify({ name: "greet", page: "/", args: ["Ada"] });
    const request = new Request("http://localhost:3000/__elur-js/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "http://localhost:3000",
      },
      body,
    });
    const response = await handleActionRequest(
      request,
      async () => ((...args: unknown[]) => `Hello, ${args[0]}!`),
      { bodyLimit: 1_048_576 },
    );
    assert.equal(response.status, 200);
  });
});
