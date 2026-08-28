import { matchRoute, matchApiRoute } from "../ssr/match.js";
import { handleActionRequest, type ActionResolver } from "../action/server.js";
import { renderPage, renderErrorPage } from "../ssr/render.js";
import { renderPageBody, RouteNotFoundError } from "../ssr/stream.js";
import { actionNames } from "../action/scan.js";
import { serveStaticFile, htmlResponse, jsonResponse, notFound, methodNotAllowed } from "./context.js";
import { publicErrorResponse } from "../errors.js";
import { getCachedHtml, setCachedHtml } from "../cache.js";
import { shouldCachePublic, type CachePolicy } from "../cache/policy.js";
import { buildSecurityHeaders, applySecurityHeaders } from "./security-headers.js";
import type { SecurityHeadersConfig } from "../config/index.js";

// --- Unified Web handler ---
//
// A single function that turns a Web Request into a Web Response. Every
// runtime entry point (Node CLI, Bun adapter, Vercel, Netlify, Vite dev)
// eventually calls this handler so behavior is identical across platforms.
//
// Responsibilities (in order):
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
  const cacheDir = options.cacheDir;
  const defaultRevalidate = options.defaultRevalidate;

  const renderConfig = { lang, clientEntry, renderEndpoint };
  const securityHeadersConfig = options.securityHeaders ?? {};

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

  async function handleActions(request: Request): Promise<Response> {
    try {
      return await handleActionRequest(request, actionResolver);
    } catch (err) {
      console.error("[elur-kit] action error:", err);
      return publicErrorResponse(err, { includeDetail: noCache });
    }
  }

  async function handleRenderEndpoint(request: Request, url: URL): Promise<Response> {
    const page = url.searchParams.get("page") ?? "/";
    const search = url.searchParams.get("search") ?? "";
    const wantsJson = (request.headers.get("Accept") ?? "").includes("application/json");
    try {
      const { body, title } = await renderPageBody({
        routes,
        pathname: page,
        searchParams: new URLSearchParams(search),
        config: renderConfig,
        actions: publicActions,
        request,
        importer: options.importer,
      });
      if (wantsJson) return jsonResponse({ title, body });
      return htmlResponse(body);
    } catch (err) {
      if (err instanceof RouteNotFoundError) return notFound("Not Found");
      // A thrown Response from a loader is a first-class response (A-22).
      if (err instanceof Response) return err;
      console.error("[elur-kit] render endpoint error:", err);
      return publicErrorResponse(err, { includeDetail: noCache });
    }
  }

  async function handleApiRoute(
    request: Request,
    pathname: string,
  ): Promise<Response | null> {
    const apiMatch = matchApiRoute(pathname, routes.api);
    if (!apiMatch) return null;
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
      const ctx = { params: apiMatch.params, locals: {} as Record<string, unknown> };
      const response = (await (handler as (req: Request, ctx?: { params: Record<string, string | string[]>; locals: Record<string, unknown> }) => unknown)(request, ctx)) as Response;
      return response;
    } catch (err) {
      console.error("[elur-kit] API route error:", err);
      return publicErrorResponse(err, { includeDetail: noCache });
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

  async function handleDynamicRender(request: Request, pathname: string): Promise<Response> {
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

    // ISR cache check (only when caching is enabled and the request is
    // cacheable — no cookies, no authorization header).
    const cacheable = !noCache && cacheDir && isCacheable(request);
    if (cacheable && cacheDir) {
      const cached = await getCachedHtml(cacheDir, pathname);
      if (cached) return htmlResponse(cached.html);
    }

    try {
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

      if (cacheable && cacheDir && isResultCacheable(result, request)) {
        const revalidateSeconds = result.revalidate ?? defaultRevalidate ?? 0;
        if (revalidateSeconds > 0) {
          await setCachedHtml(cacheDir, pathname, result.html, revalidateSeconds);
        }
      }

      return htmlResponse(result.html);
    } catch (err) {
      // A thrown Response from a loader is a first-class response (A-22).
      if (err instanceof Response) return err;
      console.error("[elur-kit] SSR render error:", err);
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
    }
  }

  return async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const isHttps = url.protocol === "https:";

    // Determine security headers (rebuild if nonce is needed).
    // HSTS is only applied under HTTPS; other headers apply always.
    const secHeaders = securityHeadersConfig === false
      ? {}
      : buildSecurityHeaders(securityHeadersConfig, isHttps);

    // 1. Server actions endpoint.
    if (pathname === "/__elur-js/actions" && request.method === "POST") {
      const response = await handleActions(request);
      return applySecurityHeaders(response, secHeaders);
    }

    // 2. SPA render endpoint.
    if (pathname === "/__elur-js/render" && renderEndpoint) {
      const response = await handleRenderEndpoint(request, url);
      return applySecurityHeaders(response, secHeaders);
    }

    // 3. API routes.
    const apiResponse = await handleApiRoute(request, pathname);
    if (apiResponse) return applySecurityHeaders(apiResponse, secHeaders);

    // 4. Static files.
    const staticResponse = await handleStatic(pathname, request);
    if (staticResponse) return applySecurityHeaders(staticResponse, secHeaders);

    // 5. Dynamic SSR rendering.
    const dynamicResponse = await handleDynamicRender(request, pathname);
    return applySecurityHeaders(dynamicResponse, secHeaders);
  };
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
