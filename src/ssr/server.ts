import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { scanRoutes } from "../router/route-scanner.js";
import { scanActions, actionNames } from "../action/scan.js";
import { handleActionRequest, type ActionSecurityOptions } from "../action/server.js";
import { getCachedHtml, setCachedHtml } from "../cache.js";
import { matchApiRoute, matchRoute } from "./match.js";
import { renderPage, renderErrorPage } from "./render.js";
import { renderPageBody, renderStreamingPage, RouteNotFoundError } from "./stream.js";
import { loadMiddleware, matchesMiddleware, runMiddleware } from "../middleware/index.js";
import { incomingMessageToRequest } from "../runtime/node-http.js";
import { resolveStaticFile } from "../runtime/static.js";
import { toPublicErrorInfo } from "../errors.js";

export interface SsrServerOptions {
  /** Absolute path to the app directory (e.g. /project/src/app). */
  appDir: string;
  /** Absolute path to the project root. When provided, action paths in the
   * serialized HTML shell are made relative to this root. */
  root?: string;
  /** Absolute path to the public directory for static files (optional). */
  publicDir?: string;
  /** Base path for the client entry module, e.g. "/_elur/entry-client.js". */
  clientEntry?: string;
  /** Default language for the HTML shell. */
  lang?: string;
  port?: number;
  host?: string;
  /** Absolute path to the ISR cache directory (optional). */
  cacheDir?: string;
  /** Default revalidate interval in seconds when a page does not export one. */
  defaultRevalidate?: number;
  /** If true, render pages with loading.ts boundaries using streaming. */
  streaming?: boolean;
  /** CSRF / origin policy applied to the server actions endpoint. */
  actionSecurity?: ActionSecurityOptions;
}

export interface SsrServer {
  server: Server;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Create an SSR server that renders pages on demand and serves static files.
 */
export async function createSsrServer(options: SsrServerOptions): Promise<SsrServer> {
  const routes = await scanRoutes(options.appDir);
  const actions = await scanActions(options.appDir);
  const publicActions = actionNames(actions);

  // Load user middleware (src/middleware.ts) if it exists.
  const middleware = options.root ? await loadMiddleware(options.root) : null;

  const resolveAction = async (name: string, page?: string) => {
    const pageKey = resolveActionPageKey(page, routes);
    const pageActions = pageKey ? actions[pageKey] : Object.values(actions).find((p) => p[name]) ?? undefined;
    const actionPath = pageActions ? pageActions[name] : undefined;
    if (!actionPath) return undefined;
    const mod = (await import(actionPath)) as Record<string, unknown>;
    const action = mod[name];
    if (typeof action === "function") {
      return action as (...args: unknown[]) => unknown;
    }
    return undefined;
  };

  const server = createServer(async (req, res) => {
    let urlPath = req.url ?? "/";
    if (urlPath.includes("?")) urlPath = urlPath.split("?")[0];

    // Server actions endpoint.
    if (urlPath === "/__elur-js/actions" && req.method === "POST") {
      try {
        const body = await readRequestBody(req);
        const request = incomingMessageToRequest(req, body);
        const response = await handleActionRequest(request, resolveAction, options.actionSecurity);
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(await response.text());
      } catch (err) {
        console.error("[action] error handling", err);
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(toPublicErrorInfo(err).message);
      }
      return;
    }

    if (urlPath === "/__elur-js/render") {
      const renderUrl = new URL(req.url ?? "/", "http://localhost");
      const page = renderUrl.searchParams.get("page") ?? "/";
      const search = renderUrl.searchParams.get("search") ?? "";
      const wantsJson = (req.headers["accept"] ?? "").includes("application/json");
      try {
        const request = incomingMessageToRequest(req);

        // ISR: cache the real content served by this endpoint when a cache
        // directory is configured, so streamed pages regenerate on a TTL.
        let body: string;
        let title: string;
        let lastRenderedCookie: string | undefined;
        let lastRenderedHead: string | undefined;
        const ttl = await resolveTtl(options, page, routes);
        const cacheKey = `/__elur-js/render${page}?${search}`;
        if (options.cacheDir && typeof ttl === "number" && canUsePublicCache(request)) {
          const cached = await getCachedHtml(options.cacheDir, cacheKey);
          if (cached) {
            body = extractBody(cached.html);
            title = extractTitle(cached.html);
          } else {
            const rendered = await renderPageBody({
              routes,
              pathname: page,
              searchParams: new URLSearchParams(search),
              config: { lang: options.lang ?? "es", clientEntry: options.clientEntry },
              actions: publicActions,
              request,
            });
            body = rendered.body;
            title = rendered.title;
            lastRenderedCookie = rendered.clearActionErrorCookie;
            lastRenderedHead = rendered.head;
            await setCachedHtml(options.cacheDir, cacheKey, rendered.fullHtml ?? "", ttl);
          }
        } else {
          const rendered = await renderPageBody({
            routes,
            pathname: page,
            searchParams: new URLSearchParams(search),
            config: { lang: options.lang ?? "es", clientEntry: options.clientEntry },
            actions: publicActions,
            request,
          });
          body = rendered.body;
          title = rendered.title;
          lastRenderedCookie = rendered.clearActionErrorCookie;
          lastRenderedHead = rendered.head;
        }

        if (wantsJson) {
          const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
          // The SPA router applies the cookie via document.cookie so the next
          // full reload does not re-feed stale errors to the page.
          const setCookie = lastRenderedCookie;
          if (setCookie) headers["X-Elur-Action-Clear-Cookie"] = setCookie;
          res.writeHead(200, headers);
          res.end(JSON.stringify({ title, body, head: lastRenderedHead, clearActionErrorCookie: setCookie }));
        } else {
          const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" };
          if (lastRenderedCookie) headers["Set-Cookie"] = lastRenderedCookie;
          res.writeHead(200, headers);
          res.end(body);
        }
      } catch (err) {
        if (err instanceof RouteNotFoundError) {
          console.log(`[ssr] render endpoint: no route for ${page}`);
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }
        console.error("[ssr] streaming render error", err);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
      return;
    }

    // Run middleware before routing (skip for internal endpoints handled above).
    let middlewareHeaders: Record<string, string> | undefined;
    if (middleware && matchesMiddleware(urlPath, middleware.config)) {
      const mwResult = await runMiddleware(middleware, incomingMessageToRequest(req));
      if (mwResult.kind === "response") {
        res.writeHead(mwResult.response.status, Object.fromEntries(mwResult.response.headers.entries()));
        res.end(Buffer.from(await mwResult.response.arrayBuffer()));
        return;
      }
      middlewareHeaders = mwResult.headers;
    }

    // Try API routes first.
    const apiMatch = matchApiRoute(urlPath, routes.api);
    if (apiMatch) {
      try {
        const mod = (await import(apiMatch.route.routePath)) as Record<
          string,
          (request: Request, context?: { params: Record<string, string | string[]> }) => unknown
        >;
        const handler = mod[req.method ?? "GET"];
        if (typeof handler !== "function") {
          res.writeHead(405, { "Content-Type": "text/plain" });
          res.end(`Method not allowed: ${req.method}`);
          return;
        }
        const body = req.method && req.method !== "GET" && req.method !== "HEAD" ? await readRequestBody(req) : undefined;
        const request = incomingMessageToRequest(req, body);
        applyHeaders(request.headers, middlewareHeaders);
        const response = (await handler(request, { params: apiMatch.params })) as Response;
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (err) {
        console.error("[api] error handling", urlPath, err);
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(toPublicErrorInfo(err).message);
      }
      return;
    }

    // Try static files first.
    if (options.publicDir) {
      try {
        const served = await tryServeStatic(res, options.publicDir, urlPath);
        if (served) return;
      } catch (err) {
        console.error("[static] error serving", urlPath, err);
      }
    }

    // Try SSR page rendering.
    const match = matchRoute(urlPath, routes.pages);
    const config = { lang: options.lang ?? "es", clientEntry: options.clientEntry };
    if (match) {
      try {
        const request = incomingMessageToRequest(req);
        applyHeaders(request.headers, middlewareHeaders);

        let html: string;
        let clearActionErrorCookie: string | undefined;
        const revalidate = match.route.dataPath
          ? ((await import(match.route.dataPath)) as { revalidate?: number }).revalidate
          : undefined;
        const ttl = revalidate ?? options.defaultRevalidate;
        const useStreaming = options.streaming !== false && match.route.loadingPath;
        if (useStreaming) {
          html = await renderStreamingPage({
            route: match.route,
            params: match.params,
            searchParams: new URLSearchParams(req.url?.split("?")[1] ?? ""),
            config,
            actions: publicActions,
            request,
          });
        } else if (options.cacheDir && typeof ttl === "number" && canUsePublicCache(request)) {
          const cacheKey = new URL(request.url).pathname + new URL(request.url).search;
          const cached = await getCachedHtml(options.cacheDir, cacheKey);
          if (cached) {
            html = cached.html;
          } else {
            const result = await renderPage({
              route: match.route,
              params: match.params,
              searchParams: new URLSearchParams(req.url?.split("?")[1] ?? ""),
              config,
              actions: publicActions,
              request,
            });
            html = result.html;
            clearActionErrorCookie = result.clearActionErrorCookie;
            await setCachedHtml(options.cacheDir, cacheKey, html, ttl);
          }
        } else {
          const result = await renderPage({
            route: match.route,
            params: match.params,
            searchParams: new URLSearchParams(req.url?.split("?")[1] ?? ""),
            config,
            actions: publicActions,
            request,
          });
          html = result.html;
          clearActionErrorCookie = result.clearActionErrorCookie;
        }
        const responseHeaders: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" };
        if (clearActionErrorCookie) responseHeaders["Set-Cookie"] = clearActionErrorCookie;
        res.writeHead(200, responseHeaders);
        res.end(html);
        return;
      } catch (err) {
        console.error("[ssr] error rendering", urlPath, err);
        const errorResult = await renderErrorPage({
          routes,
          status: 500,
          error: err,
          config,
          actions: publicActions,
        });
        if (errorResult) {
          res.writeHead(errorResult.status, { "Content-Type": "text/html; charset=utf-8" });
          res.end(errorResult.html);
        } else {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(toPublicErrorInfo(err).message);
        }
        return;
      }
    }

    const errorResult = await renderErrorPage({
      routes,
      status: 404,
      config,
      actions: publicActions,
    });
    if (errorResult) {
      res.writeHead(errorResult.status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(errorResult.html);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Not found: ${req.url}`);
  });

  return {
    server,
    listen() {
      return new Promise((resolve) => {
        server.listen(options.port ?? 3000, options.host ?? "127.0.0.1", () => {
          console.log(
            `\n  → SSR server http://${options.host ?? "127.0.0.1"}:${options.port ?? 3000}`,
          );
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function tryServeStatic(
  res: import("node:http").ServerResponse,
  publicDir: string,
  urlPath: string,
): Promise<boolean> {
  const filePath = await resolveStaticFile(publicDir, urlPath);
  if (!filePath) return false;
  const contentType = guessContentType(filePath);
  let data: Buffer | string = await readFile(filePath);
  if (contentType.includes("text/html")) {
    // The SSG build bakes `render-endpoint content="off"` into the static
    // HTML so purely static deployments never probe the endpoint. This server
    // (SSR `start`) DOES expose /__elur-js/render, so advertise it: SPA
    // navigations then fetch live server-rendered content instead of the
    // stale static file (e.g. after a mutating server action).
    data = data
      .toString("utf8")
      .replace(
        '<meta name="elur:render-endpoint" content="off" />',
        '<meta name="elur:render-endpoint" content="on" />',
      );
  }
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(data) });
  res.end(data);
  return true;
}

function canUsePublicCache(request: Request): boolean {
  return !request.headers.has("cookie") && !request.headers.has("authorization");
}

function applyHeaders(headers: Headers, values: Record<string, string> | undefined): void {
  if (!values) return;
  for (const [name, value] of Object.entries(values)) headers.set(name, value);
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function guessContentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

/**
 * Maps a concrete page path (e.g. `/movies/inception`) to the route pattern
 * key used by the action registry (e.g. `/movies/:slug`). Falls back to the
 * path itself when it matches an exact registry key.
 */
export function resolveActionPageKey(
  page: string | undefined,
  routes: Awaited<ReturnType<typeof scanRoutes>>,
): string | undefined {
  if (!page) return undefined;
  if (routes.pages.some((route) => route.path === page)) return page;
  const match = matchRoute(page, routes.pages);
  return match ? match.route.path : page;
}

/** Resolves the ISR TTL for a page: route `revalidate` or the default. */
async function resolveTtl(
  options: SsrServerOptions,
  pathname: string,
  routes: Awaited<ReturnType<typeof scanRoutes>>,
): Promise<number | undefined> {
  const match = matchRoute(pathname, routes.pages);
  if (!match) return undefined;
  const revalidate = match.route.dataPath
    ? ((await import(match.route.dataPath)) as { revalidate?: number }).revalidate
    : undefined;
  return revalidate ?? options.defaultRevalidate;
}

function extractBody(fullHtml: string): string {
  const match = fullHtml.match(/<div id="app">([\s\S]*)<\/div>\s*(<script|$)/);
  return match ? match[1].trim() : fullHtml;
}

function extractTitle(fullHtml: string): string {
  const match = fullHtml.match(/<title>([^<]*)<\/title>/);
  return match ? match[1] : "";
}
