// RequestContext tests (runtime-security §4)
//
// Verifies that RequestContext carries all per-request state required by the
// runtime-security design document:
//   - request, url, searchParams
//   - params (from route matching)
//   - locals (per-request, not global)
//   - cookies (read from request, write to response)
//   - signal (abort)
//   - requestId (unique per request)
//   - platform (opaque)
//   - route (matched route)
//   - response (status, headers, cookies)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RequestContext, type RouteTable } from "../src/runtime/context.ts";
import type { ResolvedElurConfig } from "../src/config/index.ts";

function makeConfig(): ResolvedElurConfig {
  return {
    root: "/tmp/test",
    appDir: "src/app",
    islandsDir: "src/islands",
    contentDir: "src/content",
    publicDir: "public",
    outDir: "dist",
    site: undefined,
    base: "/",
    trailingSlash: "ignore",
    output: "server",
    adapter: undefined,
    images: {},
    cache: { dir: ".elur/cache", defaultRevalidate: 60 },
    security: { headers: true },
    router: { redirects: [], rewrites: [], headers: [] },
    integrations: [],
  } as unknown as ResolvedElurConfig;
}

function makeRoutes(): RouteTable {
  return { pages: [], api: [] };
}

function makeRequest(url = "http://localhost:3000/path", headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("RequestContext: per-request state (§4)", () => {
  it("carries request and url", () => {
    const ctx = new RequestContext({
      request: makeRequest("http://localhost:3000/blog/hello"),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
    });
    assert.equal(ctx.url.pathname, "/blog/hello");
    assert.equal(ctx.method, "GET");
  });

  it("generates a unique requestId", () => {
    const ctx1 = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
    });
    const ctx2 = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
    });
    assert.ok(ctx1.requestId, "should have a request ID");
    assert.ok(ctx2.requestId, "should have a request ID");
    assert.notEqual(ctx1.requestId, ctx2.requestId, "IDs should be unique");
  });

  it("accepts a custom requestId", () => {
    const ctx = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
      requestId: "custom-123",
    });
    assert.equal(ctx.requestId, "custom-123");
  });

  it("has per-request locals (not global)", () => {
    const ctx1 = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
    });
    const ctx2 = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
    });
    ctx1.locals.user = "alice";
    assert.equal(ctx1.locals.user, "alice");
    assert.equal(ctx2.locals.user, undefined, "locals should not leak between requests");
  });

  it("accepts pre-populated locals from middleware", () => {
    const ctx = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
      locals: { tenant: "acme" },
    });
    assert.equal(ctx.locals.tenant, "acme");
  });

  it("carries route params", () => {
    const ctx = new RequestContext({
      request: makeRequest("http://localhost:3000/blog/hello-world"),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
      params: { slug: "hello-world" },
    });
    assert.equal(ctx.params.slug, "hello-world");
  });

  it("has an abort signal", () => {
    const controller = new AbortController();
    const ctx = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
      signal: controller.signal,
    });
    assert.equal(ctx.signal, controller.signal);
    assert.equal(ctx.signal.aborted, false);
    controller.abort();
    assert.equal(ctx.signal.aborted, true);
  });

  it("generates a default signal when none provided", () => {
    const ctx = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
    });
    assert.ok(ctx.signal, "should have a signal");
    assert.equal(ctx.signal.aborted, false);
  });

  it("carries platform context", () => {
    const platform = { name: "vercel", region: "iad1" };
    const ctx = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
      platform,
    });
    assert.deepEqual(ctx.platform, platform);
  });
});

describe("RequestContext: cookies (§4)", () => {
  it("reads cookies from request", () => {
    const ctx = new RequestContext({
      request: makeRequest("http://localhost/", { Cookie: "session=abc123; theme=dark" }),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
    });
    assert.equal(ctx.cookies.get("session"), "abc123");
    assert.equal(ctx.cookies.get("theme"), "dark");
    assert.equal(ctx.cookies.has("session"), true);
    assert.equal(ctx.cookies.has("nonexistent"), false);
  });

  it("returns empty cookies when none present", () => {
    const ctx = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
    });
    assert.equal(ctx.cookies.get("session"), undefined);
    assert.deepEqual(ctx.cookies.getAll(), {});
  });

  it("writes response cookies via ResponseCookieJar", () => {
    const ctx = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
    });
    ctx.response.cookies.set("session", "xyz", { httpOnly: true, secure: true, sameSite: "lax" });
    ctx.response.cookies.set("theme", "dark");

    const cookies = ctx.response.cookies.getAll();
    assert.equal(cookies.length, 2);
    assert.ok(cookies[0]!.includes("session=xyz"));
    assert.ok(cookies[0]!.includes("HttpOnly"));
    assert.ok(cookies[0]!.includes("Secure"));
    assert.ok(cookies[0]!.includes("SameSite=lax"));
    assert.ok(cookies[1]!.includes("theme=dark"));
  });

  it("clears cookies by setting them expired", () => {
    const ctx = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
    });
    ctx.response.cookies.clear("session", { path: "/" });
    const cookies = ctx.response.cookies.getAll();
    assert.equal(cookies.length, 1);
    assert.ok(cookies[0]!.includes("session="));
    assert.ok(cookies[0]!.includes("Max-Age=0"));
  });
});

describe("RequestContext: response state (§4)", () => {
  it("has mutable response headers", () => {
    const ctx = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
    });
    ctx.response.headers.set("X-Custom", "value");
    ctx.response.status = 201;
    assert.equal(ctx.response.headers.get("X-Custom"), "value");
    assert.equal(ctx.response.status, 201);
  });

  it("applyToResponse merges headers and cookies", () => {
    const ctx = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
    });
    ctx.response.headers.set("X-Custom", "value");
    ctx.response.cookies.set("session", "abc", { httpOnly: true });
    ctx.response.status = 201;

    const original = new Response("body", { status: 200, headers: { "Content-Type": "text/html" } });
    const applied = ctx.applyToResponse(original);

    assert.equal(applied.status, 201);
    assert.equal(applied.headers.get("X-Custom"), "value");
    assert.equal(applied.headers.get("Content-Type"), "text/html");
    const setCookies = applied.headers.getSetCookie?.() ?? [];
    assert.ok(setCookies.some((c) => c.includes("session=abc")));
  });

  it("applyToResponse preserves original status when no override", () => {
    const ctx = new RequestContext({
      request: makeRequest(),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
    });
    const original = new Response("body", { status: 404 });
    const applied = ctx.applyToResponse(original);
    assert.equal(applied.status, 404);
  });
});

describe("RequestContext: searchParams (§4)", () => {
  it("exposes searchParams from URL", () => {
    const ctx = new RequestContext({
      request: makeRequest("http://localhost/?foo=bar&baz=qux"),
      config: makeConfig(),
      routes: makeRoutes(),
      actions: {},
      publicActions: {},
    });
    assert.equal(ctx.searchParams.get("foo"), "bar");
    assert.equal(ctx.searchParams.get("baz"), "qux");
  });
});
