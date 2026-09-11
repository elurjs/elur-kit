import { matchRoute, matchApiRoute } from "../ssr/match.js";
import { handleActionRequest, type ActionResolver } from "../action/server.js";
import { renderPage, renderErrorPage } from "../ssr/render.js";
import { renderPageBody, RouteNotFoundError } from "../ssr/stream.js";
import { actionNames } from "../action/scan.js";
import { serveStaticFile, htmlResponse, jsonResponse, notFound, methodNotAllowed } from "./context.js";
import { publicErrorResponse } from "../errors.js";
import { cacheKey, createFsCacheAdapter, type CacheAdapter } from "../cache/adapter.js";
import { connectCacheAdapter } from "../cache/invalidation.js";
import { shouldCachePublic, type CachePolicy } from "../cache/policy.js";
import { buildSecurityHeaders, applySecurityHeaders } from "./security-headers.js";
import { createRequestLogger, type LogLevel, type StructuredLogger } from "./logger.js";
import { matchRedirect, matchRewrite, matchRouteHeaders, type RedirectRule, type RewriteRule, type RouteHeadersRule } from "../router/redirects.js";
import { matchesMiddleware, runMiddleware, type LoadedMiddleware } from "../middleware/index.js";
import { createStreamingResponse } from "../ssr/stream-response.js";
import { supportsStreaming, DEFAULT_CAPABILITIES, type AdapterCapabilities } from "./capabilities.js";
import type { SecurityHeadersConfig } from "../config/index.js";

// --- Unified Web handler ---
//
// A single function that turns a Web Request into a Web Response. Every
// runtime entry point (Node CLI, Bun adapter, Vercel, Netlify, Vite dev)
// eventually calls this handler so behavior is identical across platforms.
//
// Responsibilities (in order):
//   0. Redirects and rewrites declared in the config.
//   1. Server actions endpoint (/__elur-js/actions).
//   2. SPA render endpoint (/__elur-js/render).
//   3. API routes.
//   4. Static files from the output directory.
//   5. Dynamic SSR rendering for unmatched paths.
//   6. 404 / 500 error pages.
//
// The handler is pure: it does not import Node HTTP types and can be used in
// Bun, Deno, Cloudflare Workers, Vercel Edge, etc.

export interface WebHandlerOptions {
  /** Static file root (absolute path). Usually the build output directory. */
  staticRoot: string;
  /** Whether to bypass the ISR cache (dev mode). */
  noCache?: boolean;
  /** ISR cache directory (absolute). */
  cacheDir?: string;
  /** Default ISR revalidate interval in seconds. */
  defaultRevalidate?: number;
  /** Optional module loader for adapter-bundled entries. */
  importer?: (path: string) => Promise<unknown>;
  /** HTML lang attribute. */
  lang?: string;
  /** Client entry path. */
  clientEntry?: string;
  /** Whether the render endpoint exists. */
  renderEndpoint?: boolean;
  /** Security headers config (runtime-security §14). `false` disables. */
  securityHeaders?: SecurityHeadersConfig | false;
  /** Minimum log level for the per-request structured logger. */
  logLevel?: LogLevel;
  /**
   * Pluggable ISR cache adapter. When omitted and `cacheDir` is set, a
   * filesystem adapter is created and shared per `cacheDir` for the process.
   */
  cacheAdapter?: CacheAdapter;
  /** Redirect rules evaluated before any routing (first match wins). */
  redirects?: RedirectRule[];
  /** Rewrite rules: transparently change the pathname used for routing. */
  rewrites?: RewriteRule[];
  /** Extra response headers applied to matching request paths. */
  routeHeaders?: RouteHeadersRule[];
  /**
   * Opt-in streaming SSR (experimental). When `true`, dynamic routes with a
   * `loading` boundary are served as a real stream: the document shell plus
   * the loading fallback go out immediately, and the resolved content arrives
   * as a follow-up chunk that swaps the boundary in-place. Streamed responses
   * bypass the ISR cache (they always render live) and send
   * `Cache-Control: no-store` + `X-Accel-Buffering: no`. Routes without a
   * loading boundary render buffered exactly as before.
   */
  streaming?: boolean;
  /**
   * Host capabilities used to gate streaming. Defaults to
   * `DEFAULT_CAPABILITIES` (a full Node/Bun process). Adapters for hosts
   * without streaming support should pass their own capabilities so
   * `streaming: true` degrades to buffered rendering instead of breaking.
   */
  capabilities?: AdapterCapabilities;
  /**
   * User middleware (the project's `src/middleware.ts`, loaded by the caller
   * with `loadMiddleware`). Runs after redirects/rewrites and the internal
   * endpoints, before API/static/SSR routing. A returned Response
   * short-circuits the pipeline; `next({ headers, locals })` merges headers
   * into the downstream request and exposes `locals` to API routes.
   */
  middleware?: LoadedMiddleware;
  /**
   * Client router options affecting SSR output: `enabled` controls the
   * render-endpoint marker and whether a page without islands ships any JS;
   * `entry` is the public URL of the split router chunk (e.g.
   * `/_elur/router.js`) when the client bundle was built with separate
   * entry/router inputs.
   */
  router?: { enabled?: boolean; entry?: string };
  /**
   * Client JS mode. `"legacy"` restores the pre-0%-JS behavior: the combined
   * client entry is emitted unconditionally on every page.
   */
  js?: "modern" | "legacy";
}

export interface WebHandlerRouteTable {
  pages: import("../router/route-scanner.js").PageRoute[];
  api: import("../router/route-scanner.js").ApiRoute[];
  error404?: import("../router/route-scanner.js").PageRoute;
  error500?: import("../router/route-scanner.js").PageRoute;
}

export interface WebHandlerActionRegistry {
  [pagePath: string]: Record<string, string>;
}

export interface CreateWebHandlerResult {
  (request: Request): Promise<Response>;
}

/**
 * Create a unified Web handler from scanned routes, actions and options.
 *
 * The returned function is the single entry point for all runtimes.
 */
export function createWebHandler(
  routes: WebHandlerRouteTable,
  actions: WebHandlerActionRegistry,
  options: WebHandlerOptions,
): CreateWebHandlerResult {
  const publicActions = actionNames(actions);
  const lang = options.lang ?? "es";
  const clientEntry = options.clientEntry;
  const renderEndpoint = options.renderEndpoint ?? true;
  const noCache = options.noCache ?? false;
  const defaultRevalidate = options.defaultRevalidate;

  const renderConfig = {
    lang,
    clientEntry,
    renderEndpoint,
    router: options.router
      ? { enabled: options.router.enabled !== false, entry: options.router.entry }
      : undefined,
    js: options.js,
  };
  const securityHeadersConfig = options.securityHeaders ?? {};
  const redirectRules = options.redirects ?? [];
  const rewriteRules = options.rewrites ?? [];
  const routeHeaderRules = options.routeHeaders ?? [];
  const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
  // Streaming is opt-in AND requires a host that can flush chunks as they are
  // produced; when either is missing every route renders buffered.
  const streamingEnabled = options.streaming === true && supportsStreaming(capabilities);
  const cacheAdapter = resolveCacheAdapter(options);
  if (cacheAdapter && !invalidatorConnectedAdapters.has(cacheAdapter)) {
    invalidatorConnectedAdapters.add(cacheAdapter);
    // The subscription lives for the process lifetime: defaultInvalidator is
    // a module-level singleton and dev/preview recreate the handler per
    // request, so connecting per call would leak listeners.
    connectCacheAdapter(cacheAdapter);
  }

  function createActionResolver(): ActionResolver {
    return async (name: string, page?: string) => {
      const pageKey = page
        ? routes.pages.some((route) => route.path === page)
          ? page
          : (matchRoute(page, routes.pages)?.route.path ?? page)
        : undefined;
      const pageActions = pageKey ? actions[pageKey] : Object.values(actions).find((p) => p[name]) ?? undefined;
      const actionPath = pageActions ? pageActions[name] : undefined;
      if (!actionPath) return undefined;
      if (options.importer) {
        const mod = (await options.importer(actionPath)) as Record<string, unknown>;
        const action = mod[name];
        if (typeof action === "function") return action as (...args: unknown[]) => unknown;
        return undefined;
      }
      const mod = (await import(actionPath)) as Record<string, unknown>;
      const action = mod[name];
      if (typeof action === "function") return action as (...args: unknown[]) => unknown;
      return undefined;
    };
  }

  const actionResolver = createActionResolver();

  async function handleActions(request: Request, logger: StructuredLogger): Promise<Response> {
    const stopTimer = logger.startTimer("action", "Server action");
    try {
      return await handleActionRequest(request, actionResolver);
    } catch (err) {
      logger.error("[elur-kit] action error", {
        path: new URL(request.url).pathname,
        method: request.method,
        error: errorMessage(err),
        stack: errorStack(err),
      });
      return publicErrorResponse(err, { includeDetail: noCache });
    } finally {
      stopTimer();
    }
  }

  async function handleRenderEndpoint(request: Request, url: URL, logger: StructuredLogger): Promise<Response> {
    const page = url.searchParams.get("page") ?? "/";
    const search = url.searchParams.get("search") ?? "";
    const wantsJson = (request.headers.get("Accept") ?? "").includes("application/json");
    const stopTimer = logger.startTimer("render-endpoint", "SPA render endpoint");
    try {
      const result = await renderPageBody({
        routes,
        pathname: page,
        searchParams: new URLSearchParams(search),
        config: renderConfig,
        actions: publicActions,
        request,
        importer: options.importer,
      });
      // A thrown Response from a loader is a first-class response (A-22).
      if (result.response) return result.response;
      const { body, title, head, clearActionErrorCookie, data, actions } = result;
      if (wantsJson) {
        // The full SPA payload: head keeps OG/Twitter metadata fresh on
        // navigation, data/actions keep the inert JSON scripts in sync, and
        // the clear-cookie is also relayed as a header for parity with dev.
        const headers: Record<string, string> = {};
        if (clearActionErrorCookie) {
          headers["X-Elur-Action-Clear-Cookie"] = clearActionErrorCookie;
        }
        // `?? null` keeps every key present in the wire shape — JSON.stringify
        // drops undefined values and the parity contract expects a stable
        // payload across runtimes.
        return jsonResponse(
          {
            title,
            body,
            head: head ?? null,
            data: data ?? null,
            actions: actions ?? null,
            clearActionErrorCookie: clearActionErrorCookie ?? null,
          },
          200,
          headers,
        );
      }
      return htmlResponse(
        body,
        200,
        clearActionErrorCookie ? { "Set-Cookie": clearActionErrorCookie } : undefined,
      );
    } catch (err) {
      if (err instanceof RouteNotFoundError) return notFound("Not Found");
      // A thrown Response from a loader is a first-class response (A-22).
      if (err instanceof Response) return err;
      logger.error("[elur-kit] render endpoint error", {
        path: url.pathname,
        page,
        error: errorMessage(err),
        stack: errorStack(err),
      });
      return publicErrorResponse(err, { includeDetail: noCache });
    } finally {
      stopTimer();
    }
  }

  async function handleApiRoute(
    request: Request,
    pathname: string,
    logger: StructuredLogger,
    middlewareLocals?: Record<string, unknown>,
  ): Promise<Response | null> {
    const apiMatch = matchApiRoute(pathname, routes.api);
    if (!apiMatch) return null;
    const stopTimer = logger.startTimer("api", "API route");
    try {
      let mod: Record<string, unknown>;
      if (options.importer) {
        mod = (await options.importer(apiMatch.route.routePath as unknown as string)) as Record<string, unknown>;
      } else {
        mod = (await import(apiMatch.route.routePath)) as Record<string, unknown>;
      }
      const handler = mod[request.method ?? "GET"];
      if (typeof handler !== "function") return methodNotAllowed(request.method ?? "GET");
      // Pass params and a writable locals object to the API handler
      // (runtime-security §4: params derived from the effective route).
      // `locals` carries values published by the user middleware via next().
      const ctx = { params: apiMatch.params, locals: middlewareLocals ?? {} as Record<string, unknown> };
      const response = (await (handler as (req: Request, ctx?: { params: Record<string, string | string[]>; locals: Record<string, unknown> }) => unknown)(request, ctx)) as Response;
      return response;
    } catch (err) {
      logger.error("[elur-kit] API route error", {
        path: pathname,
        method: request.method,
        route: apiMatch.route.path,
        error: errorMessage(err),
        stack: errorStack(err),
      });
      return publicErrorResponse(err, { includeDetail: noCache });
    } finally {
      stopTimer();
    }
  }

  async function handleStatic(pathname: string, request: Request): Promise<Response | null> {
    const response = await serveStaticFile(options.staticRoot, pathname, request);
    if (response && noCache) {
      const ct = response.headers.get("Content-Type") ?? "";
      if (ct.includes("text/html")) {
        // Dev mode: strip the render-endpoint marker so the client router uses
        // the live /__elur-js/render endpoint for fast SPA navigation.
        const stripped = (await response.text())
          .replace('<meta name="elur:render-endpoint" content="off" />', "");
        return new Response(stripped, {
          status: response.status,
          headers: { "Content-Type": ct, "Cache-Control": "no-store, must-revalidate" },
        });
      }
      return new Response(response.body, {
        status: response.status,
        headers: { ...Object.fromEntries(response.headers.entries()), "Cache-Control": "no-store, must-revalidate" },
      });
    }
    if (response && renderEndpoint) {
      const ct = response.headers.get("Content-Type") ?? "";
      if (ct.includes("text/html")) {
        const headers = Object.fromEntries(response.headers.entries());
        delete headers["content-length"];
        const body = await response.text();
        if (body.includes('elur:render-endpoint" content="off"')) {
          // The SSG build baked `render-endpoint content="off"` so static
          // deployments never probe the endpoint. This server exposes
          // /__elur-js/render, so advertise it: SPA navigations fetch live
          // server-rendered content instead of the stale static file.
          const rewritten = body.replace(
            '<meta name="elur:render-endpoint" content="off" />',
            '<meta name="elur:render-endpoint" content="on" />',
          );
          return new Response(rewritten, { status: response.status, headers });
        }
        return new Response(body, { status: response.status, headers });
      }
    }
    return response;
  }

  async function handleDynamicRender(request: Request, pathname: string, logger: StructuredLogger): Promise<Response> {
    const match = matchRoute(pathname, routes.pages);
    if (!match) {
      const errorResult = await renderErrorPage({
        routes,
        status: 404,
        config: renderConfig,
        actions: publicActions,
        importer: options.importer,
      });
      if (errorResult) return htmlResponse(errorResult.html, errorResult.status);
      return notFound(`Not found: ${pathname}`);
    }

    // Streaming SSR (opt-in): routes with a loading boundary are served as a
    // real stream — shell + fallback first, resolved content as a later chunk.
    // Streamed responses bypass the ISR cache entirely (a half-sent stream is
    // not cacheable; these pages render live on every request), so the cache
    // gates below only apply to the buffered path.
    if (streamingEnabled && match.route.loadingPath) {
      // The timer measures time-to-shell: the Response is returned once the
      // shell is ready while the background render continues streaming.
      const stopStreamTimer = logger.startTimer("ssr", "SSR stream shell");
      try {
        return await createStreamingResponse({
          route: match.route,
          params: match.params,
          searchParams: new URLSearchParams(request.url.split("?")[1] ?? ""),
          config: renderConfig,
          actions: publicActions,
          importer: options.importer,
          request,
          signal: request.signal,
        });
      } catch (err) {
        // A thrown Response from a loader is a first-class response (A-22).
        if (err instanceof Response) return err;
        logger.error("[elur-kit] SSR stream error", {
          path: pathname,
          route: match.route.path,
          error: errorMessage(err),
          stack: errorStack(err),
        });
        const errorResult = await renderErrorPage({
          routes,
          status: 500,
          error: err,
          config: renderConfig,
          actions: publicActions,
          importer: options.importer,
        }).catch(() => undefined);
        if (errorResult) return htmlResponse(errorResult.html, errorResult.status);
        return publicErrorResponse(err, { includeDetail: noCache });
      } finally {
        stopStreamTimer();
      }
    }

    // ISR cache (only when caching is enabled and the request is cacheable —
    // no cookies, no authorization header). Pages are stored in the cache
    // adapter under cacheKey(pathname); the same key scheme is used by
    // path-based invalidation (connectCacheAdapter).
    const cacheable = !noCache && cacheAdapter && isCacheable(request);
    const pageCacheKey = cacheable ? cacheKey(pathname) : undefined;

    const renderAndStore = async (): Promise<Response> => {
      const result = await renderPage({
        route: match.route,
        params: match.params,
        searchParams: new URLSearchParams(request.url.split("?")[1] ?? ""),
        config: renderConfig,
        actions: publicActions,
        request,
        importer: options.importer,
      });

      // If a loader threw a Response (redirect, 404, etc.), return it
      // as a first-class response (A-22).
      if (result.response) {
        return result.response;
      }

      if (cacheable && cacheAdapter && pageCacheKey && isResultCacheable(result, request)) {
        const revalidateSeconds = result.revalidate ?? defaultRevalidate ?? 0;
        if (revalidateSeconds > 0) {
          await cacheAdapter.set(
            pageCacheKey,
            { html: result.html, generatedAt: Date.now(), revalidate: revalidateSeconds },
            { revalidate: revalidateSeconds, tags: result.cachePolicy?.tags },
          );
        }
      }

      return htmlResponse(result.html);
    };

    if (cacheable && cacheAdapter && pageCacheKey) {
      const cached = await cacheAdapter.get(pageCacheKey);
      if (cached) {
        if (Date.now() - cached.generatedAt >= cached.revalidate * 1000) {
          // Stale-while-revalidate: serve the stale entry immediately and
          // refresh it in the background.
          renderAndStore().catch((err) => {
            logger.error("[elur-kit] background cache revalidation failed", {
              path: pathname,
              error: errorMessage(err),
              stack: errorStack(err),
            });
          });
        }
        return htmlResponse(cached.html);
      }
    }

    const stopTimer = logger.startTimer("ssr", "SSR render");
    try {
      return await renderAndStore();
    } catch (err) {
      // A thrown Response from a loader is a first-class response (A-22).
      if (err instanceof Response) return err;
      logger.error("[elur-kit] SSR render error", {
        path: pathname,
        route: match.route.path,
        error: errorMessage(err),
        stack: errorStack(err),
      });
      const errorResult = await renderErrorPage({
        routes,
        status: 500,
        error: err,
        config: renderConfig,
        actions: publicActions,
        importer: options.importer,
      }).catch(() => undefined);
      if (errorResult) return htmlResponse(errorResult.html, errorResult.status);
      return publicErrorResponse(err, { includeDetail: noCache });
    } finally {
      stopTimer();
    }
  }

  // Applies security headers plus the per-request observability headers
  // (Server-Timing when there are metrics, X-Request-ID always) and any
  // configured route headers. Route headers may override security headers;
  // the observability headers are applied last so they always win.
  function finalizeResponse(
    response: Response,
    logger: StructuredLogger,
    secHeaders: Record<string, string>,
    routeHeaders?: Record<string, string>,
  ): Response {
    const secured = applySecurityHeaders(response, secHeaders);
    const headers = new Headers(secured.headers);
    if (routeHeaders) {
      for (const [key, value] of Object.entries(routeHeaders)) {
        headers.set(key, value);
      }
    }
    const timing = logger.getServerTimingHeader();
    if (timing) headers.set("Server-Timing", timing);
    headers.set("X-Request-ID", logger.getRequestId());
    return new Response(secured.body, {
      status: secured.status,
      statusText: secured.statusText,
      headers,
    });
  }

  return async function handler(request: Request): Promise<Response> {
    const logger = createRequestLogger(request, options.logLevel);
    const url = new URL(request.url);
    const originalPathname = url.pathname;
    const isHttps = url.protocol === "https:";

    // Determine security headers (rebuild if nonce is needed).
    // HSTS is only applied under HTTPS; other headers apply always.
    const secHeaders = securityHeadersConfig === false
      ? {}
      : buildSecurityHeaders(securityHeadersConfig, isHttps);

    // 0. Redirects, evaluated before any routing.
    if (redirectRules.length > 0) {
      const redirect = matchRedirect(originalPathname, redirectRules);
      if (redirect) {
        return finalizeResponse(redirect, logger, secHeaders, matchRouteHeaders(originalPathname, routeHeaderRules));
      }
    }

    // Rewrites change the pathname transparently: everything below (API
    // routes, static files, dynamic SSR and its ISR cache key) routes on the
    // rewritten path, while route headers keep matching the original URL the
    // user configured them for.
    let pathname = originalPathname;
    if (rewriteRules.length > 0) {
      pathname = matchRewrite(originalPathname, rewriteRules) ?? originalPathname;
    }
    const routeHeaders = matchRouteHeaders(originalPathname, routeHeaderRules);

    // 1. Server actions endpoint.
    if (pathname === "/__elur-js/actions" && request.method === "POST") {
      const response = await handleActions(request, logger);
      return finalizeResponse(response, logger, secHeaders, routeHeaders);
    }

    // 2. SPA render endpoint.
    if (pathname === "/__elur-js/render" && renderEndpoint) {
      const response = await handleRenderEndpoint(request, url, logger);
      return finalizeResponse(response, logger, secHeaders, routeHeaders);
    }

    // User middleware (src/middleware.ts) runs after redirects/rewrites and
    // the internal endpoints, before routing — same semantics as the legacy
    // createSsrServer pipeline. A returned Response short-circuits (through
    // finalizeResponse so security/observability headers still apply);
    // next({ headers }) merges into the downstream request and
    // next({ locals }) is exposed to API routes.
    let middlewareLocals: Record<string, unknown> | undefined;
    const middleware = options.middleware;
    if (middleware && matchesMiddleware(pathname, middleware.config)) {
      let mwResult;
      try {
        mwResult = await runMiddleware(middleware, request);
      } catch (err) {
        logger.error("[elur-kit] middleware error", {
          path: pathname,
          error: errorMessage(err),
          stack: errorStack(err),
        });
        return finalizeResponse(
          publicErrorResponse(err, { includeDetail: noCache }),
          logger,
          secHeaders,
          routeHeaders,
        );
      }
      if (mwResult.kind === "response") {
        return finalizeResponse(mwResult.response, logger, secHeaders, routeHeaders);
      }
      middlewareLocals = mwResult.locals;
      if (mwResult.headers) {
        const merged = new Headers(request.headers);
        for (const [key, value] of Object.entries(mwResult.headers)) {
          merged.set(key, value);
        }
        request = new Request(request, { headers: merged });
      }
    }

    // 3. API routes.
    const apiResponse = await handleApiRoute(request, pathname, logger, middlewareLocals);
    if (apiResponse) return finalizeResponse(apiResponse, logger, secHeaders, routeHeaders);

    // 4. Static files.
    const staticResponse = await handleStatic(pathname, request);
    if (staticResponse) return finalizeResponse(staticResponse, logger, secHeaders, routeHeaders);

    // 5. Dynamic SSR rendering.
    const dynamicResponse = await handleDynamicRender(request, pathname, logger);
    return finalizeResponse(dynamicResponse, logger, secHeaders, routeHeaders);
  };
}

// Default filesystem adapters are shared per cacheDir and connected to the
// invalidator once; both live for the process lifetime (dev/preview recreate
// the handler per request, so per-call adapters would leak listeners).
const defaultCacheAdapters = new Map<string, CacheAdapter>();
const invalidatorConnectedAdapters = new WeakSet<CacheAdapter>();

function resolveCacheAdapter(options: WebHandlerOptions): CacheAdapter | undefined {
  if (options.cacheAdapter) return options.cacheAdapter;
  if (!options.cacheDir) return undefined;
  let adapter = defaultCacheAdapters.get(options.cacheDir);
  if (!adapter) {
    adapter = createFsCacheAdapter({ cacheDir: options.cacheDir });
    defaultCacheAdapters.set(options.cacheDir, adapter);
  }
  return adapter;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorStack(err: unknown): string | undefined {
  return err instanceof Error ? err.stack : undefined;
}

function isCacheable(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (request.headers.get("Cookie")) return false;
  if (request.headers.get("Authorization")) return false;
  return true;
}

/**
 * Checks whether a rendered page result is cacheable as public ISR.
 * Per runtime-security §9.1: uses the route's cache policy and checks
 * for personalized content markers.
 */
function isResultCacheable(
  result: { revalidate?: number; html: string; cachePolicy?: CachePolicy },
  request: Request,
): boolean {
  // If the HTML contains action error markers, it's personalized.
  if (result.html.includes("__elur_js_action_error")) return false;
  // Use the route's cache policy if declared.
  if (result.cachePolicy) {
    return shouldCachePublic(result.cachePolicy, request);
  }
  // Fallback: cacheable only if revalidate > 0 and request is clean.
  if (!result.revalidate || result.revalidate <= 0) return false;
  if (request.headers.get("Cookie")) return false;
  if (request.headers.get("Authorization")) return false;
  return true;
}
