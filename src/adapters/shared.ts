import { existsSync } from "node:fs";
import { mkdir, readdir, copyFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { scanRoutes } from "../router/route-scanner.js";
import type { AdapterOptions } from "./index.js";
import type { PageRoute } from "../router/route-scanner.js";

/**
 * Shared helper: copy a directory recursively.
 */
export async function copyStatic(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) {
      await copyStatic(src, dest);
    } else {
      await copyFile(src, dest);
    }
  }
}

/** Adds every module the SSR runtime may import for a page to the registry. */
function collectPageModules(
  page: PageRoute,
  moduleSet: Set<string>,
  actionPathsByPage: Map<string, Set<string>>,
): void {
  moduleSet.add(page.pagePath);
  if (page.dataPath) moduleSet.add(page.dataPath);
  if (page.loadingPath) moduleSet.add(page.loadingPath);
  for (const layout of page.layouts) {
    moduleSet.add(layout);
    const layoutDataPath = layout.replace(/layout\.ts$/, "layout.data.ts");
    if (layoutDataPath !== layout && existsSync(layoutDataPath)) {
      moduleSet.add(layoutDataPath);
    }
  }
  if (page.actionPath) {
    moduleSet.add(page.actionPath);
    let set = actionPathsByPage.get(page.path);
    if (!set) {
      set = new Set<string>();
      actionPathsByPage.set(page.path, set);
    }
    set.add(page.actionPath);
  }
}

/**
 * Build a self-contained SSR entry file for a platform adapter.
 * The generated module exports a default `handler(request: Request): Response`
 * and embeds the full route table plus a registry of all page/layout/data/
 * action modules so the runtime never touches the file system.
 */
export async function buildSsrEntry(
  routes: Awaited<ReturnType<typeof scanRoutes>>,
  options: AdapterOptions,
  entryDir: string,
): Promise<string> {
  // Collect all module paths that the SSR runtime may need to import.
  const moduleSet = new Set<string>();
  const actionPathsByPage = new Map<string, Set<string>>();
  for (const page of routes.pages) {
    collectPageModules(page, moduleSet, actionPathsByPage);
  }
  if (routes.error404) collectPageModules(routes.error404, moduleSet, actionPathsByPage);
  if (routes.error500) collectPageModules(routes.error500, moduleSet, actionPathsByPage);
  for (const api of routes.api) {
    moduleSet.add(api.routePath);
  }
  const modules = Array.from(moduleSet);
  const moduleIndex = new Map(modules.map((path, index) => [path, index]));

  const imports = modules
    .map((path, index) => {
      const rel = relativeToPosix(entryDir, path);
      return `import * as m_${index} from ${JSON.stringify(rel)};`;
    })
    .join("\n");

  const renderPageRecord = (page: PageRoute): string => `{
    path: ${JSON.stringify(page.path)},
    pagePath: ${JSON.stringify(page.pagePath)},
    dataPath: ${JSON.stringify(page.dataPath ?? null)},
    actionPath: ${JSON.stringify(page.actionPath ?? null)},
    loadingPath: ${JSON.stringify(page.loadingPath ?? null)},
    layouts: ${JSON.stringify(page.layouts)},
    params: ${JSON.stringify(page.params)},
  }`;

  const pages = routes.pages.map(renderPageRecord).join(",\n");

  const apiRoutes = routes.api
    .map((api) => {
      const index = moduleIndex.get(api.routePath);
      return `  { path: ${JSON.stringify(api.path)}, routePath: m_${index} },`;
    })
    .join("\n");

  const actionModules = Array.from(actionPathsByPage.entries())
    .map(([pagePath, paths]) => {
      const entries = Array.from(paths)
        .map((path) => {
          const index = moduleIndex.get(path);
          return `      [${JSON.stringify(path)}, m_${index}],`;
        })
        .join("\n");
      return `  [${JSON.stringify(pagePath)}, new Map([\n${entries}\n    ])],`;
    })
    .join("\n");

  const actionsRegistry: Record<string, string[]> = {};
  for (const page of routes.pages) {
    if (!page.actionPath) continue;
    const mod = (await import(page.actionPath)) as Record<string, unknown>;
    const names: string[] = [];
    for (const [name, value] of Object.entries(mod)) {
      if (name === "default") continue;
      if (typeof value === "function") {
        names.push(name);
      }
    }
    if (names.length > 0) {
      actionsRegistry[page.path] = names;
    }
  }

  // The render config baked into the generated handler. The split router
  // chunk is advertised only when the bundle actually emitted it (the file
  // exists in the build output), so single-input legacy bundles keep working.
  const routerEnabled = options.router?.enabled !== false;
  const routerEntry =
    routerEnabled && options.js !== "legacy" &&
      existsSync(resolve(options.root, options.outDir, "_elur", "router.js"))
      ? "/_elur/router.js"
      : null;

  return `// AUTO-GENERATED by @elurjs/kit. Do not edit.
import { handleActionRequest, matchApiRoute, matchRoute, renderPage, renderPageBody, renderErrorPage, createStreamingResponse } from "@elurjs/kit";
${imports}

const registry = new Map<string, unknown>([
${modules.map((path, index) => `  [${JSON.stringify(path)}, m_${index}],`).join("\n")}
]);

const pages = [
${pages},
];

const apiRoutes = [
${apiRoutes}
];

const actionModules = new Map<string, Map<string, unknown>>([
${actionModules}
]);

const actions = ${JSON.stringify(actionsRegistry)};

const routes = {
  pages,
  api: apiRoutes,
  error404: ${routes.error404 ? renderPageRecord(routes.error404) : "undefined"},
  error500: ${routes.error500 ? renderPageRecord(routes.error500) : "undefined"},
};

const clientEntry = ${JSON.stringify(options.clientEntry)};
const lang = ${JSON.stringify(options.lang)};
// Client router/JS emission rules baked at adapter build time.
const router = ${JSON.stringify({ enabled: routerEnabled, entry: routerEntry })};
const jsMode = ${JSON.stringify(options.js === "legacy" ? "legacy" : "modern")};
// Opt-in streaming SSR (experimental): routes with a loading boundary stream
// the shell first and swap in the resolved content as a follow-up chunk.
const streaming = ${options.streaming === true};

function loadModule(path: string) {
  const mod = registry.get(path);
  if (mod) return mod;
  throw new Error(\`Module not found in registry: \${path}\`);
}

async function resolveAction(name: string, page?: string) {
  // Match concrete page paths (e.g. /movies/inception) to their route pattern
  // (/movies/:slug) so actions on dynamic routes resolve by scope.
  let pageKey: string | undefined;
  if (page) {
    pageKey = routes.pages.some((route) => route.path === page)
      ? page
      : (matchRoute(page, routes.pages)?.route.path ?? page);
  }
  const pageModules = pageKey ? actionModules.get(pageKey) : undefined;
  const candidates = pageModules ? [...pageModules.values()] : [];
  if (!pageModules) {
    for (const mods of actionModules.values()) {
      for (const mod of mods.values()) {
        const action = (mod as Record<string, unknown>)[name];
        if (typeof action === "function") return action;
      }
    }
  }
  for (const mod of candidates) {
    const action = (mod as Record<string, unknown>)[name];
    if (typeof action === "function") {
      return action as (...args: unknown[]) => unknown;
    }
  }
  return undefined;
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/__elur-js/actions") {
    return handleActionRequest(request, resolveAction);
  }

  // Render endpoint used by the SPA router and streaming boundaries.
  if (url.pathname === "/__elur-js/render") {
    const page = url.searchParams.get("page") ?? "/";
    const search = url.searchParams.get("search") ?? "";
    const wantsJson = (request.headers.get("Accept") ?? "").includes("application/json");
    try {
      const result = await renderPageBody({
        routes,
        pathname: page,
        searchParams: new URLSearchParams(search),
        config: { lang, clientEntry, router, js: jsMode },
        importer: loadModule,
        actions,
        request,
      });
      // A thrown Response from a loader is a first-class response (A-22).
      if (result.response) return result.response;
      const { body, title, head, clearActionErrorCookie, data, actions: actionsPayload } = result;
      if (wantsJson) {
        const headers = { "Content-Type": "application/json; charset=utf-8" };
        if (clearActionErrorCookie) headers["X-Elur-Action-Clear-Cookie"] = clearActionErrorCookie;
        // The ?? null fallbacks keep every key present — JSON.stringify drops
        // undefined and the SPA payload shape must be stable across runtimes.
        return new Response(
          JSON.stringify({
            title,
            body,
            head: head ?? null,
            data: data ?? null,
            actions: actionsPayload ?? null,
            clearActionErrorCookie: clearActionErrorCookie ?? null,
          }),
          { status: 200, headers },
        );
      }
      const headers = { "Content-Type": "text/html; charset=utf-8" };
      if (clearActionErrorCookie) headers["Set-Cookie"] = clearActionErrorCookie;
      return new Response(body, { status: 200, headers });
    } catch (err) {
      if ((err as { name?: string }).name === "RouteNotFoundError") {
        return new Response("Not Found", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        });
      }
      console.error("[elur-kit] render endpoint error:", err);
      return new Response("Internal Server Error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  }

  const apiMatch = matchApiRoute(url.pathname, apiRoutes);
  if (apiMatch) {
    const mod = apiMatch.route.routePath as Record<
      string,
      (request: Request, context?: { params: Record<string, string | string[]> }) => unknown
    >;
    const handler = mod[request.method ?? "GET"];
    if (typeof handler !== "function") {
      return new Response("Method not allowed: " + request.method, { status: 405, headers: { "Content-Type": "text/plain" } });
    }
    return (await handler(request, { params: apiMatch.params })) as Response;
  }

  const match = matchRoute(url.pathname, routes.pages);
  if (!match) {
    const errorResult = await renderErrorPage({ routes, status: 404, config: { lang, clientEntry, router, js: jsMode }, actions, importer: loadModule });
    if (errorResult) {
      return new Response(errorResult.html, { status: errorResult.status, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  try {
    if (streaming && match.route.loadingPath) {
      // Streaming SSR: shell + loading boundary first, resolved content as a
      // follow-up chunk. Streamed pages are rendered live (no cache).
      return createStreamingResponse({
        route: match.route,
        params: match.params,
        searchParams: new URLSearchParams(url.search),
        config: { lang, clientEntry, router, js: jsMode },
        importer: loadModule,
        actions,
        request,
        signal: request.signal,
      });
    }
    const result = await renderPage({
      route: match.route,
      params: match.params,
      searchParams: new URLSearchParams(url.search),
      config: { lang, clientEntry, router, js: jsMode },
      importer: loadModule,
      actions,
      request,
    });
    // A thrown Response from a loader is a first-class response (A-22).
    if (result.response) return result.response;
    const headers = { "Content-Type": "text/html; charset=utf-8" };
    if (result.clearActionErrorCookie) headers["Set-Cookie"] = result.clearActionErrorCookie;
    return new Response(result.html, { status: 200, headers });
  } catch (err) {
    console.error("[elur-kit] SSR render error:", err);
    const errorResult = await renderErrorPage({ routes, status: 500, error: err, config: { lang, clientEntry, router, js: jsMode }, actions, importer: loadModule });
    if (errorResult) {
      return new Response(errorResult.html, { status: errorResult.status, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("Internal Server Error", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
`;
}

function relativeToPosix(from: string, to: string): string {
  return relative(from, to).split("\\").join("/");
}

/**
 * Write a generated SSR entry file for an adapter.
 */
export async function writeSsrEntry(
  entryPath: string,
  routes: Awaited<ReturnType<typeof scanRoutes>>,
  options: AdapterOptions,
): Promise<void> {
  await writeFile(
    entryPath,
    await buildSsrEntry(routes, options, dirname(entryPath)),
    "utf8",
  );
}
