import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { Plugin, Connect, ViteDevServer } from "vite";
import { scanRoutes } from "../router/route-scanner.js";
import { scanActions, actionNames, type ActionRegistry } from "../action/scan.js";
import { handleActionRequest, type ActionSecurityOptions } from "../action/server.js";
import { scanIslands } from "../island/scan.js";
import { buildEntrySource } from "../island/generate-entry.js";
import { matchApiRoute, matchRoute } from "../ssr/match.js";
import { renderPage, renderErrorPage } from "../ssr/render.js";
import { setContentRoot, clearContentCache } from "../content/collections.js";
import { loadMiddleware, matchesMiddleware, runMiddleware, type LoadedMiddleware } from "../middleware/index.js";
import { nixJsInterpolationPlugin, shouldUseLegacyInterpolation, type InterpolationMode } from "./interpolation-plugin.js";
import { incomingMessageToRequest } from "../runtime/node-http.js";

export interface NixJsKitViteOptions {
  /** App directory relative to Vite root (default: src/app). */
  appDir?: string;
  /** Islands directory relative to Vite root (default: src/islands). */
  islandsDir?: string;
  /** Content directory relative to Vite root (default: src/content). */
  contentDir?: string;
  /** Where to write the generated client entry (default: .nix-js/entry-client.ts). */
  generatedEntry?: string;
  /** Public path for the client entry module (default: /_nix-js/entry-client.js). */
  clientEntry?: string;
  /** HTML lang attribute (default: es). */
  lang?: string;
  /** Import specifier for hydrateIslands in the generated entry. */
  hydrateImport?: string;
  /** Import specifier for startClientRouter in the generated entry. */
  routerImport?: string;
  /** CSRF / origin policy applied to the server actions endpoint in dev. */
  actionSecurity?: ActionSecurityOptions;
  /**
   * How the legacy interpolation transform is handled (default: "auto").
   * With a Nix.js core that supports partial attribute interpolation natively
   * the transform is not applied; use "legacy" for migrations against older
   * cores and "off" to never transform.
   */
  interpolation?: InterpolationMode;
}

/**
 * Official Vite plugin for nix-js-kit.
 *
 * In dev mode it generates the islands entry and renders every page via SSR.
 * In production builds it can be combined with `nix-js-kit build` to generate
 * static HTML files.
 */
export function nixJsKit(options: NixJsKitViteOptions = {}): Plugin[] {
  const appDir = options.appDir ?? "src/app";
  const islandsDir = options.islandsDir ?? "src/islands";
  const contentDir = options.contentDir ?? "src/content";
  const generatedEntry = options.generatedEntry ?? ".nix-js/entry-client.ts";
  const clientEntry = options.clientEntry ?? "/_nix-js/entry-client.js";
  const lang = options.lang ?? "es";
  const hydrateImport = options.hydrateImport ?? "@deijose/nix-js-kit/island";
  const routerImport = options.routerImport ?? "@deijose/nix-js-kit/router";

  let routes: Awaited<ReturnType<typeof scanRoutes>> | null = null;
  let actions: ActionRegistry = {};
  let root: string = ".";
  let middleware: LoadedMiddleware | null = null;

  const mainPlugin: Plugin = {
    name: "nix-js-kit",
    enforce: "pre",

    async configResolved(config) {
      root = config.root;
      const entryPath = resolve(root, generatedEntry);
      const islands = await scanIslands(resolve(root, islandsDir));
      const source = buildEntrySource(islands, entryPath, hydrateImport, routerImport);
      await mkdir(dirname(entryPath), { recursive: true });
      await writeFile(entryPath, source, "utf8");

      const appDirPath = resolve(root, appDir);
      routes = await scanRoutes(appDirPath);
      actions = await scanActions(appDirPath);

      // Wire up the content layer root so getCollection/getEntry resolve
      // from the user's src/content directory.
      setContentRoot(resolve(root, contentDir));

      // Load user middleware (src/middleware.ts) if it exists.
      middleware = await loadMiddleware(root);
    },

    configureServer(server) {
      const ssrLoad = createSsrLoader(server, root);
      const resolveAction = createActionResolver(() => actions, () => routes, ssrLoad);

      const appDirPath = resolve(root, appDir);
      const islandsDirPath = resolve(root, islandsDir);
      const contentDirPath = resolve(root, contentDir);
      setupHmr(server, appDirPath, islandsDirPath, contentDirPath, root, generatedEntry, hydrateImport, routerImport, () => {
        routes = null;
        actions = {};
        clearContentCache();
      });

      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const urlPath = requestUrl.pathname;

        // Server actions endpoint.
        if (urlPath === "/__nix-js/actions" && req.method === "POST") {
          try {
            const body = await readRequestBody(req);
            const request = incomingMessageToRequest(req, body);
            const response = await handleActionRequest(request, resolveAction, options.actionSecurity);
            res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
            res.end(await response.text());
          } catch (err) {
            console.error("[nix-js-kit] action error:", err);
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(String(err));
          }
          return;
        }

        if (urlPath.startsWith("/_nix-js/entry-client.js")) {
          const transformed = await server.transformRequest(
            "/.nix-js/entry-client.ts",
          );
          if (transformed) {
            res.writeHead(200, {
              "Content-Type": "application/javascript; charset=utf-8",
              "Cache-Control": "no-store, must-revalidate",
            });
            res.end(transformed.code);
            return;
          }
        }

        const currentRoutes = routes ?? (routes = await scanRoutes(appDirPath));
        const currentActions = Object.keys(actions).length ? actions : (actions = await scanActions(appDirPath));

        // Render endpoint used by the SPA router and streaming boundaries.
        if (urlPath === "/__nix-js/render") {
          const { renderPageBody, RouteNotFoundError } = await import("../ssr/stream.js");
          try {
            const page = requestUrl.searchParams.get("page") ?? "/";
            const search = requestUrl.searchParams.get("search") ?? "";
            const wantsJson = (req.headers["accept"] ?? "").includes("application/json");
            const request = incomingMessageToRequest(req);
            const { body, title, head, clearActionErrorCookie } = await renderPageBody({
              routes: currentRoutes,
              pathname: page,
              searchParams: new URLSearchParams(search),
              config: { lang, clientEntry },
              actions: actionNames(currentActions),
              importer: ssrLoad,
              request,
            });
            if (wantsJson) {
              const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
              if (clearActionErrorCookie) headers["X-Nix-Action-Clear-Cookie"] = clearActionErrorCookie;
              res.writeHead(200, headers);
              res.end(JSON.stringify({ title, body, head, clearActionErrorCookie }));
            } else {
              const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" };
              if (clearActionErrorCookie) headers["Set-Cookie"] = clearActionErrorCookie;
              res.writeHead(200, headers);
              res.end(body);
            }
            return;
          } catch (err) {
            if (err instanceof RouteNotFoundError) {
              res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
              res.end("Not Found");
              return;
            }
            console.error("[nix-js-kit] render endpoint error:", err);
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(String(err));
            return;
          }
        }

        if (!urlPath.startsWith("/@") && !urlPath.startsWith("/node_modules/") && !urlPath.includes(".")) {
          const apiMatch = matchApiRoute(urlPath, currentRoutes.api);
          if (apiMatch) {
            try {
              const mod = (await ssrLoad(apiMatch.route.routePath)) as Record<
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
              const response = (await handler(request, { params: apiMatch.params })) as Response;
              res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
              res.end(Buffer.from(await response.arrayBuffer()));
            } catch (err) {
              console.error("[nix-js-kit] API route error:", err);
              res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
              res.end(String(err));
            }
            return;
          }
        }

        // Run middleware before SSR rendering.
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

        const handled = await handleSsrRequest(req, res, next, {
          routes: currentRoutes,
          actions: currentActions,
          clientEntry,
          lang,
          ssrLoad,
          middlewareHeaders,
        });
        if (!handled) next();
      });
    },
  };

  return shouldUseLegacyInterpolation(options.interpolation ?? "auto")
    ? [mainPlugin, nixJsInterpolationPlugin({ appDir, islandsDir })]
    : [mainPlugin];
}

export { nixJsInterpolationPlugin, type InterpolationPluginOptions } from "./interpolation-plugin.js";
export type { InterpolationMode } from "./interpolation-plugin.js";

function setupHmr(
  server: ViteDevServer,
  appDirPath: string,
  islandsDirPath: string,
  contentDirPath: string,
  root: string,
  generatedEntry: string,
  hydrateImport: string,
  routerImport: string,
  invalidate: () => void,
) {
  const isRelevant = (path: string) =>
    path.startsWith(appDirPath) || path.startsWith(islandsDirPath) || path.startsWith(contentDirPath);

  async function regenerateIslandEntry() {
    const islands = await scanIslands(islandsDirPath);
    const entryPath = resolve(root, generatedEntry);
    const source = buildEntrySource(islands, entryPath, hydrateImport, routerImport);
    await mkdir(dirname(entryPath), { recursive: true });
    await writeFile(entryPath, source, "utf8");
    const entryMod = server.moduleGraph.getModuleById(entryPath);
    if (entryMod) server.moduleGraph.invalidateModule(entryMod);
  }

  server.watcher.on("change", async (path) => {
    if (!isRelevant(path)) return;
    invalidate();
    const mod = server.moduleGraph.getModuleById(path);
    if (mod) server.moduleGraph.invalidateModule(mod);
    if (path.startsWith(islandsDirPath)) {
      await regenerateIslandEntry();
      console.log("[nix-js-kit] HMR reload islands after change:", path);
    } else if (path.startsWith(contentDirPath) && path.endsWith(".md")) {
      console.log("[nix-js-kit] HMR content changed:", path);
    } else if (path.includes(".action.ts") || path.includes(".data.ts") || path.includes("page.ts") || path.includes("layout.ts")) {
      console.log("[nix-js-kit] HMR reload routes/actions after change:", path);
    }
  });

  server.watcher.on("add", async (path) => {
    if (!isRelevant(path)) return;
    invalidate();
    if (path.startsWith(islandsDirPath)) {
      await regenerateIslandEntry();
    }
    console.log("[nix-js-kit] HMR new file detected:", path);
  });

  server.watcher.on("unlink", async (path) => {
    if (!isRelevant(path)) return;
    invalidate();
    const mod = server.moduleGraph.getModuleById(path);
    if (mod) server.moduleGraph.invalidateModule(mod);
    if (path.startsWith(islandsDirPath)) {
      await regenerateIslandEntry();
    }
    console.log("[nix-js-kit] HMR file removed:", path);
  });
}

function createSsrLoader(server: ViteDevServer, root: string) {
  return (filePath: string) => {
    const rel = relative(root, filePath);
    const url = "/" + rel.split("\\").join("/");
    return server.ssrLoadModule(url);
  };
}

function createActionResolver(
  getActions: () => import("../action/scan.js").ActionRegistry,
  getRoutes: () => Awaited<ReturnType<typeof scanRoutes>> | null,
  ssrLoad: (path: string) => Promise<unknown>,
) {
  return async (name: string, page?: string) => {
    const actions = getActions();
    const routes = getRoutes();
    let pageKey: string | undefined;
    if (page && routes) {
      pageKey = routes.pages.some((route) => route.path === page)
        ? page
        : (matchRoute(page, routes.pages)?.route.path ?? page);
    }
    const pageActions = pageKey ? actions[pageKey] : Object.values(actions).find((p) => p[name]) ?? undefined;
    const actionPath = pageActions ? pageActions[name] : undefined;
    if (!actionPath) return undefined;
    const mod = (await ssrLoad(actionPath)) as Record<string, unknown>;
    const action = mod[name];
    if (typeof action === "function") {
      return action as (...args: unknown[]) => unknown;
    }
    return undefined;
  };
}

function readRequestBody(req: Connect.IncomingMessage): Promise<string> {
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

interface SsrHandlerOptions {
  routes: Awaited<ReturnType<typeof scanRoutes>> | null;
  actions: ActionRegistry;
  clientEntry: string;
  lang: string;
  ssrLoad: (path: string) => Promise<unknown>;
  middlewareHeaders?: Record<string, string>;
}

async function handleSsrRequest(
  req: Connect.IncomingMessage,
  res: import("node:http").ServerResponse,
  _next: Connect.NextFunction,
  options: SsrHandlerOptions,
): Promise<boolean> {
  if (!options.routes) return false;
  const publicActions = actionNames(options.actions);

  let urlPath = req.url ?? "/";
  if (urlPath.includes("?")) urlPath = urlPath.split("?")[0];

  // Let Vite handle its own internals and assets.
  if (urlPath.startsWith("/@") || urlPath.startsWith("/node_modules/")) {
    return false;
  }

  // Skip explicit file requests.
  if (urlPath.includes(".")) return false;

  const config = { lang: options.lang, clientEntry: options.clientEntry };
  const match = matchRoute(urlPath, options.routes.pages);
  if (match) {
    try {
      const request = incomingMessageToRequest(req);
      if (options.middlewareHeaders) {
        for (const [name, value] of Object.entries(options.middlewareHeaders)) request.headers.set(name, value);
      }
      const { html, clearActionErrorCookie } = await renderPage({
        route: match.route,
        params: match.params,
        searchParams: new URLSearchParams(req.url?.split("?")[1] ?? ""),
        config,
        importer: options.ssrLoad,
        actions: publicActions,
        request,
      });
      const responseHeaders: Record<string, string> = {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, must-revalidate",
      };
      if (clearActionErrorCookie) responseHeaders["Set-Cookie"] = clearActionErrorCookie;
      res.writeHead(200, responseHeaders);
      res.end(html);
      return true;
    } catch (err) {
      console.error("[nix-js-kit] SSR render error:", err);
      const errorResult = await renderErrorPage({
        routes: options.routes,
        status: 500,
        error: err,
        config,
        actions: publicActions,
        importer: options.ssrLoad,
      });
      if (errorResult) {
        res.writeHead(errorResult.status, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, must-revalidate",
        });
        res.end(errorResult.html);
      } else {
        res.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store, must-revalidate",
        });
        res.end(String(err));
      }
      return true;
    }
  }

  const errorResult = await renderErrorPage({
    routes: options.routes,
    status: 404,
    config,
    actions: publicActions,
    importer: options.ssrLoad,
  });
  if (errorResult) {
    res.writeHead(errorResult.status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, must-revalidate",
    });
    res.end(errorResult.html);
    return true;
  }

  return false;
}
