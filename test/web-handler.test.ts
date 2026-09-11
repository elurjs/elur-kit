import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebHandler } from "../src/runtime/handler.ts";
import { guessContentType, htmlResponse, jsonResponse, textResponse, notFound, methodNotAllowed, serverError } from "../src/runtime/context.ts";
import { defineAction } from "../src/action/define.ts";
import { cacheKey, createFsCacheAdapter } from "../src/cache/adapter.ts";
import { html } from "@elurjs/core";

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

describe("runtime: createWebHandler request logging", () => {
  const staticRoot = join(tempRoot, "logging");

  before(async () => {
    await mkdir(staticRoot, { recursive: true });
  });

  after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const handler = createWebHandler(
    { pages: [], api: [{ path: "/api/boom", routePath: "virtual:api-boom", params: [] }] },
    {},
    {
      staticRoot,
      noCache: true,
      importer: async () => ({
        GET() {
          throw new Error("boom");
        },
      }),
    },
  );

  it("echoes X-Request-ID and adds Server-Timing on API errors", async () => {
    const res = await handler(
      new Request("http://localhost/api/boom", { headers: { "X-Request-ID": "req-test-1" } }),
    );
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("X-Request-ID"), "req-test-1");
    assert.ok((res.headers.get("Server-Timing") ?? "").includes("api"));
  });

  it("generates an X-Request-ID when the request has none", async () => {
    const res = await handler(new Request("http://localhost/api/boom"));
    assert.ok(res.headers.get("X-Request-ID"));
  });

  it("logs API errors through the structured logger", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      await handler(new Request("http://localhost/api/boom"));
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("[elur-kit] API route error"));
    assert.ok(errors[0].includes('"route":"/api/boom"'));
  });
});

describe("runtime: createWebHandler redirects/rewrites/route headers", () => {
  const staticRoot = join(tempRoot, "routing-rules");

  before(async () => {
    await mkdir(staticRoot, { recursive: true });
    await writeFile(join(staticRoot, "index.html"), "<h1>home</h1>", "utf8");
  });

  after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const handler = createWebHandler(
    { pages: [], api: [] },
    {},
    {
      staticRoot,
      redirects: [{ from: "/old-blog/:slug", to: "/blog/:slug", status: 301 }],
      rewrites: [{ from: "/legacy", to: "/" }],
      routeHeaders: [{ path: "/legacy", headers: { "X-Route-Header": "yes" } }],
    },
  );

  it("redirects with the configured status and Location", async () => {
    const res = await handler(new Request("http://localhost/old-blog/hello"));
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("Location"), "/blog/hello");
    assert.ok(res.headers.get("X-Request-ID"));
  });

  it("rewrites the pathname before routing", async () => {
    const res = await handler(new Request("http://localhost/legacy"));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes("<h1>home</h1>"));
  });

  it("applies route headers matched against the original path", async () => {
    const res = await handler(new Request("http://localhost/legacy"));
    assert.equal(res.headers.get("X-Route-Header"), "yes");
  });

  it("does not apply route headers to non-matching paths", async () => {
    const res = await handler(new Request("http://localhost/index.html"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Route-Header"), null);
  });

  it("behaves the same without rules configured", async () => {
    const plain = createWebHandler({ pages: [], api: [] }, {}, { staticRoot });
    const res = await plain(new Request("http://localhost/legacy"));
    assert.equal(res.status, 404);
    const home = await plain(new Request("http://localhost/"));
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("X-Route-Header"), null);
  });
});


interface MockPageModules {
  loadCalls: () => number;
  importer: (path: string) => Promise<Record<string, unknown>>;
  route: { path: string; pagePath: string; dataPath: string; actionPath: string; layouts: string[]; params: string[] };
}

function mockCachedPage(path: string): MockPageModules {
  let loadCalls = 0;
  const route = {
    path,
    pagePath: `/mock${path}/page.ts`,
    dataPath: `/mock${path}/page.data.ts`,
    actionPath: `/mock${path}/page.action.ts`,
    layouts: [] as string[],
    params: [] as string[],
  };
  const importer = async (modulePath: string): Promise<Record<string, unknown>> => {
    if (modulePath.endsWith("page.data.ts")) {
      return {
        load: async () => {
          loadCalls++;
          return { n: loadCalls };
        },
        cache: { mode: "public", revalidate: 60, tags: ["pages"] },
      };
    }
    if (modulePath.endsWith("page.action.ts")) {
      return {
        refresh: defineAction({ invalidateTags: ["pages"] }, async () => ({ ok: true })),
      };
    }
    return { default: () => html`<h1>Cached page</h1>` };
  };
  return { loadCalls: () => loadCalls, importer, route };
}

describe("runtime: createWebHandler ISR cache adapter", () => {
  const staticRoot = join(tempRoot, "isr-static");

  before(async () => {
    await mkdir(staticRoot, { recursive: true });
  });

  after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("serves the second request from the cache", async () => {
    const cacheDir = join(tempRoot, "isr-cache-hit");
    const page = mockCachedPage("/cached");
    const handler = createWebHandler(
      { pages: [page.route], api: [] },
      {},
      { staticRoot, cacheDir, importer: page.importer },
    );

    const first = await handler(new Request("http://localhost/cached"));
    assert.equal(first.status, 200);
    assert.ok((await first.text()).includes("Cached page"));
    assert.equal(page.loadCalls(), 1);

    const second = await handler(new Request("http://localhost/cached"));
    assert.equal(second.status, 200);
    assert.equal(page.loadCalls(), 1, "second request should hit the cache");
  });

  it("serves stale entries while revalidating in the background", async () => {
    const cacheDir = join(tempRoot, "isr-cache-swr");
    const page = mockCachedPage("/stale");
    const handler = createWebHandler(
      { pages: [page.route], api: [] },
      {},
      { staticRoot, cacheDir, importer: page.importer },
    );

    // Pre-populate with an already-stale entry (revalidate: 1s, written 10s ago).
    const probe = createFsCacheAdapter({ cacheDir });
    await probe.set(
      cacheKey("/stale"),
      { html: "<h1>STALE</h1>", generatedAt: Date.now() - 10_000, revalidate: 1 },
      { revalidate: 1 },
    );

    const res = await handler(new Request("http://localhost/stale"));
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("STALE"), "should serve the stale entry");

    // The background revalidation re-renders and stores the fresh entry.
    const deadline = Date.now() + 3000;
    let freshHtml = "";
    while (Date.now() < deadline) {
      const entry = await probe.get(cacheKey("/stale"));
      if (entry && !entry.html.includes("STALE")) {
        freshHtml = entry.html;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(freshHtml.includes("Cached page"), "background revalidation should refresh the entry");
    assert.equal(page.loadCalls(), 1);
  });

  it("invalidates cached pages by tag after an action runs", async () => {
    const cacheDir = join(tempRoot, "isr-cache-invalidate");
    const page = mockCachedPage("/cached");
    const handler = createWebHandler(
      { pages: [page.route], api: [] },
      { "/cached": { refresh: `/mock/cached/page.action.ts` } },
      { staticRoot, cacheDir, importer: page.importer },
    );

    await handler(new Request("http://localhost/cached"));
    await handler(new Request("http://localhost/cached"));
    assert.equal(page.loadCalls(), 1, "page should be cached before the action");

    const actionRes = await handler(new Request("http://localhost/__elur-js/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name: "refresh", page: "/cached", args: [] }),
    }));
    assert.equal(actionRes.status, 200);

    const after = await handler(new Request("http://localhost/cached"));
    assert.equal(after.status, 200);
    assert.equal(page.loadCalls(), 2, "tag invalidation should force a re-render");
  });

  it("does not cache without a cacheDir or adapter", async () => {
    const page = mockCachedPage("/plain");
    const handler = createWebHandler(
      { pages: [page.route], api: [] },
      {},
      { staticRoot, importer: page.importer },
    );

    await handler(new Request("http://localhost/plain"));
    await handler(new Request("http://localhost/plain"));
    assert.equal(page.loadCalls(), 2, "every request should re-render");
  });
});

interface MockStreamingPage {
  loadCalls: () => number;
  importer: (path: string) => Promise<Record<string, unknown>>;
  route: {
    path: string;
    pagePath: string;
    dataPath?: string;
    loadingPath?: string;
    layouts: string[];
    params: string[];
  };
}

function mockStreamingPage(
  path: string,
  options: { loading?: boolean; delayMs?: number; cachePolicy?: boolean } = {},
): MockStreamingPage {
  let loadCalls = 0;
  const route = {
    path,
    pagePath: `/mock${path}/page.ts`,
    dataPath: `/mock${path}/page.data.ts`,
    loadingPath: options.loading ? `/mock${path}/loading.ts` : undefined,
    layouts: [] as string[],
    params: [] as string[],
  };
  const importer = async (modulePath: string): Promise<Record<string, unknown>> => {
    if (modulePath.endsWith("loading.ts")) {
      return { default: () => html`<p>STREAM_LOADING</p>` };
    }
    if (modulePath.endsWith("page.data.ts")) {
      return {
        load: async () => {
          loadCalls++;
          if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
          return { n: loadCalls };
        },
        ...(options.cachePolicy ? { cache: { mode: "public", revalidate: 60 } } : {}),
      };
    }
    return { default: () => html`<h1>STREAM_RESOLVED</h1>` };
  };
  return { loadCalls: () => loadCalls, importer, route };
}

describe("runtime: createWebHandler streaming SSR", () => {
  const staticRoot = join(tempRoot, "streaming-static");

  before(async () => {
    await mkdir(staticRoot, { recursive: true });
  });

  after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("streams the shell first, then the resolved content chunk", async () => {
    const page = mockStreamingPage("/stream", { loading: true, delayMs: 30 });
    const handler = createWebHandler(
      { pages: [page.route], api: [] },
      {},
      { staticRoot, streaming: true, importer: page.importer },
    );

    const res = await handler(new Request("http://localhost/stream"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("X-Accel-Buffering"), "no");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(res.headers.get("Content-Length"), null, "streamed bodies have no Content-Length");
    // Observability headers survive finalizeResponse on streamed responses.
    assert.ok(res.headers.get("X-Request-ID"));
    assert.ok((res.headers.get("Server-Timing") ?? "").includes("ssr"));

    const body = await res.text();
    // The shell carries the loading boundary, delimited by the app markers…
    assert.ok(body.includes("<!--elur:app:start-->"), "shell has the app start marker");
    assert.ok(body.includes("<!--elur:app:end-->"), "shell has the app end marker");
    assert.ok(body.includes("STREAM_LOADING"), "shell includes the loading fallback");
    // …and the resolved content arrives as a swap chunk after it.
    assert.ok(body.includes("STREAM_RESOLVED"), "resolved content chunk is present");
    assert.ok(body.includes("<template"), "resolved content uses a <template> swap chunk");
    assert.ok(
      body.indexOf("STREAM_LOADING") < body.indexOf("STREAM_RESOLVED"),
      "shell is delivered before the resolved content",
    );
  });

  it("renders buffered when streaming is off, even with a loading boundary", async () => {
    const page = mockStreamingPage("/buffered", { loading: true });
    const handler = createWebHandler(
      { pages: [page.route], api: [] },
      {},
      { staticRoot, importer: page.importer },
    );

    const res = await handler(new Request("http://localhost/buffered"));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes("STREAM_RESOLVED"));
    assert.ok(!body.includes("STREAM_LOADING"), "no loading fallback in buffered mode");
    assert.ok(!body.includes("<template"), "no swap chunk in buffered mode");
    assert.equal(res.headers.get("X-Accel-Buffering"), null);
  });

  it("falls back to buffered rendering for routes without a loading boundary", async () => {
    const page = mockStreamingPage("/no-loading", { loading: false });
    const handler = createWebHandler(
      { pages: [page.route], api: [] },
      {},
      { staticRoot, streaming: true, importer: page.importer },
    );

    const res = await handler(new Request("http://localhost/no-loading"));
    const body = await res.text();
    assert.ok(body.includes("STREAM_RESOLVED"));
    assert.ok(!body.includes("<template"), "no swap chunk without a loading boundary");
    assert.equal(res.headers.get("X-Accel-Buffering"), null);
  });

  it("falls back to buffered rendering when the host cannot stream", async () => {
    const page = mockStreamingPage("/no-stream-host", { loading: true });
    const handler = createWebHandler(
      { pages: [page.route], api: [] },
      {},
      {
        staticRoot,
        streaming: true,
        importer: page.importer,
        capabilities: { streaming: false, filesystem: "none", imageRuntime: false, backgroundWork: false },
      },
    );

    const res = await handler(new Request("http://localhost/no-stream-host"));
    const body = await res.text();
    assert.ok(body.includes("STREAM_RESOLVED"));
    assert.ok(!body.includes("<template"), "capability streaming=false disables streaming");
  });

  it("never reads from nor writes to the ISR cache", async () => {
    const cacheDir = join(tempRoot, "streaming-cache");
    const page = mockStreamingPage("/stream-cached", { loading: true, cachePolicy: true });
    const handler = createWebHandler(
      { pages: [page.route], api: [] },
      {},
      { staticRoot, cacheDir, streaming: true, importer: page.importer },
    );

    await handler(new Request("http://localhost/stream-cached"));
    await handler(new Request("http://localhost/stream-cached"));
    assert.equal(page.loadCalls(), 2, "streamed pages render live on every request");

    const probe = createFsCacheAdapter({ cacheDir });
    const entry = await probe.get(cacheKey("/stream-cached"));
    assert.equal(entry, null, "streamed responses are not stored in the ISR cache");
  });

  it("cancels the stream and discards the background render on client disconnect", async () => {
    let resolveLoad: ((value: unknown) => void) | undefined;
    const route = {
      path: "/slow",
      pagePath: "/mock/slow/page.ts",
      dataPath: "/mock/slow/page.data.ts",
      loadingPath: "/mock/slow/loading.ts",
      layouts: [] as string[],
      params: [] as string[],
    };
    const importer = async (modulePath: string): Promise<Record<string, unknown>> => {
      if (modulePath.endsWith("loading.ts")) {
        return { default: () => html`<p>STREAM_LOADING</p>` };
      }
      if (modulePath.endsWith("page.data.ts")) {
        return { load: () => new Promise((resolveLoadPromise) => { resolveLoad = resolveLoadPromise; }) };
      }
      return { default: () => html`<h1>STREAM_RESOLVED</h1>` };
    };
    const handler = createWebHandler(
      { pages: [route], api: [] },
      {},
      { staticRoot, streaming: true, importer },
    );

    const controller = new AbortController();
    const res = await handler(
      new Request("http://localhost/slow", { signal: controller.signal }),
    );
    assert.equal(res.status, 200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.ok(decoder.decode(first.value).includes("STREAM_LOADING"), "shell arrives before the render finishes");

    // Client disconnects while the loader is still running.
    controller.abort();

    const rest: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest.push(decoder.decode(value));
    }
    assert.ok(!rest.join("").includes("STREAM_RESOLVED"), "no chunks are written after the abort");

    // Let the background render finish late: it must not throw or write.
    resolveLoad?.({});
    await new Promise((r) => setTimeout(r, 50));
  });

  it("swaps an error notice into the boundary when the render fails mid-stream", async () => {
    const route = {
      path: "/boom",
      pagePath: "/mock/boom/page.ts",
      dataPath: "/mock/boom/page.data.ts",
      loadingPath: "/mock/boom/loading.ts",
      layouts: [] as string[],
      params: [] as string[],
    };
    const importer = async (modulePath: string): Promise<Record<string, unknown>> => {
      if (modulePath.endsWith("loading.ts")) {
        return { default: () => html`<p>STREAM_LOADING</p>` };
      }
      if (modulePath.endsWith("page.data.ts")) {
        return {
          load: async () => {
            throw new Error("loader exploded");
          },
        };
      }
      return { default: () => html`<h1>never</h1>` };
    };
    const handler = createWebHandler(
      { pages: [route], api: [] },
      {},
      { staticRoot, streaming: true, importer },
    );

    // Silence the handler's error log for this assertion.
    const original = console.error;
    console.error = () => {};
    let body: string;
    let res: Response;
    try {
      res = await handler(new Request("http://localhost/boom"));
      body = await res.text();
    } finally {
      console.error = original;
    }
    assert.equal(res!.status, 200, "the shell was already sent with 200");
    assert.ok(body!.includes("STREAM_LOADING"), "shell was delivered");
    assert.ok(body!.includes('role="alert"'), "the error notice replaces the boundary");
    assert.ok(body!.includes("loader exploded"), "the error is logged to the console via a script chunk");
  });
});

describe("runtime: createWebHandler middleware", () => {
  const staticRoot = join(tempRoot, "middleware-static");

  before(async () => {
    await mkdir(staticRoot, { recursive: true });
    await writeFile(join(staticRoot, "index.html"), "<h1>home</h1>", "utf8");
  });

  after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const apiRoute = { path: "/api/whoami", routePath: "virtual:api-whoami", params: [] as string[] };
  const apiImporter = async () => ({
    GET(request: Request, ctx?: { locals: Record<string, unknown> }) {
      return jsonResponse({
        injected: request.headers.get("x-injected"),
        user: ctx?.locals?.user ?? null,
      });
    },
  });

  it("short-circuits with the middleware Response (with observability headers)", async () => {
    const handler = createWebHandler(
      { pages: [], api: [] },
      {},
      {
        staticRoot,
        middleware: {
          handler: () => new Response("blocked", { status: 401 }),
          config: {},
        },
      },
    );

    const res = await handler(new Request("http://localhost/"));
    assert.equal(res.status, 401);
    assert.equal(await res.text(), "blocked");
    assert.ok(res.headers.get("X-Request-ID"), "finalizeResponse still applies");
  });

  it("merges next() headers into the downstream request and exposes locals to API routes", async () => {
    const handler = createWebHandler(
      { pages: [], api: [apiRoute] },
      {},
      {
        staticRoot,
        importer: apiImporter,
        middleware: {
          handler: (_request, ctx) => {
            ctx.next({
              headers: { "x-injected": "yes" },
              locals: { user: "ada" },
            });
          },
          config: {},
        },
      },
    );

    const res = await handler(new Request("http://localhost/api/whoami"));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(await res.text()), { injected: "yes", user: "ada" });
  });

  it("respects the matcher config", async () => {
    let calls = 0;
    const handler = createWebHandler(
      { pages: [], api: [] },
      {},
      {
        staticRoot,
        middleware: {
          handler: () => {
            calls++;
            return new Response("blocked", { status: 401 });
          },
          config: { matcher: ["/admin/:path*"] },
        },
      },
    );

    const ok = await handler(new Request("http://localhost/"));
    assert.equal(ok.status, 200, "non-matching path skips the middleware");
    assert.equal(calls, 0);

    const blocked = await handler(new Request("http://localhost/admin/panel"));
    assert.equal(blocked.status, 401);
    assert.equal(calls, 1);
  });

  it("does not run for internal endpoints", async () => {
    let calls = 0;
    const handler = createWebHandler(
      { pages: [], api: [] },
      {},
      {
        staticRoot,
        middleware: {
          handler: () => {
            calls++;
            return new Response("blocked", { status: 401 });
          },
          config: {},
        },
      },
    );

    const res = await handler(new Request("http://localhost/__elur-js/render"));
    assert.notEqual(res.status, 401, "render endpoint bypasses middleware");
    assert.equal(calls, 0);
  });

  it("runs after redirects (redirect wins first)", async () => {
    let calls = 0;
    const handler = createWebHandler(
      { pages: [], api: [] },
      {},
      {
        staticRoot,
        redirects: [{ from: "/old", to: "/new", status: 308 }],
        middleware: {
          handler: () => {
            calls++;
          },
          config: {},
        },
      },
    );

    const res = await handler(new Request("http://localhost/old"));
    assert.equal(res.status, 308);
    assert.equal(calls, 0, "redirects short-circuit before middleware");
  });
});
