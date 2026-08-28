import type { ElurTemplate } from "@elurjs/core";
import { renderToString } from "../render/render-to-string.js";
import { documentShell } from "../build/document-shell.js";
import type { PageRoute, ScannedRoutes } from "../router/route-scanner.js";
import type { BuildConfig } from "../build/build.js";
import type { PageDataLoad } from "../types.js";
import { matchRoute } from "./match.js";
import { renderPage } from "./render.js";

export interface StreamingPageOptions {
  route: PageRoute;
  params: Record<string, string | string[]>;
  searchParams: URLSearchParams;
  config: Pick<BuildConfig, "lang" | "clientEntry">;
  importer?: (path: string) => Promise<unknown>;
  actions?: Record<string, string[]>;
  request?: Request;
}

const defaultImport = (path: string) => import(path);

/** Builds the concrete URL path for a route pattern given matched params. */
function buildConcretePath(
  routePath: string,
  params: Record<string, string | string[]>,
): string {
  return routePath.replace(/:([a-zA-Z0-9_]+)(\*)?/g, (_m, name: string, catchAll?: string) => {
    const value = params[name];
    if (value === undefined || value === null) return "";
    return catchAll ? (Array.isArray(value) ? value.join("/") : String(value)) : String(value);
  });
}

function streamingScript(page: string, search: string): string {
  const src = `
    async function __elurJsStreamRender() {
      try {
        const url = "/__elur-js/render?page=" + encodeURIComponent(${JSON.stringify(page)}) + "&search=" + encodeURIComponent(${JSON.stringify(search)});
        const res = await fetch(url);
        if (!res.ok) throw new Error("Streaming render failed: " + res.status);
        const html = await res.text();
        const app = document.getElementById("app");
        if (app) app.innerHTML = html;
        document.dispatchEvent(new CustomEvent("elur:rendered"));
      } catch (err) {
        console.error("[elur-kit] streaming render failed", err);
      }
    }
    __elurJsStreamRender();
  `;
  return `<script type="module">${src}</script>`;
}

/**
 * Render a page shell that shows the loading boundary while the real content
 * is fetched and injected by the client.
 */
export async function renderStreamingPage(options: StreamingPageOptions): Promise<string> {
  const { route, params, searchParams, config, importer = defaultImport, actions } = options;
  if (!route.loadingPath) {
    throw new Error("Cannot stream a page without a loading.ts boundary");
  }

  const { default: Loading } = (await importer(route.loadingPath)) as {
    default: () => ElurTemplate;
  };

  const loadingBody = await renderToString(() => Loading());
  const concretePath = buildConcretePath(route.path, params);
  const body = `<div id="elur-loading">${loadingBody}</div>${streamingScript(concretePath, searchParams.toString())}`;

  // Apply <html> attributes and head scripts (e.g. data-theme and the no-flash
  // theme script) from the root layout loader so the shell paints correctly
  // before the real content arrives.
  const htmlAttributes: Record<string, string> = {};
  const headScripts: string[] = [];
  const headLinks: string[] = [];
  if (route.layouts.length > 0) {
    const rootLayout = route.layouts[0];
    const dataPath = rootLayout.replace(/layout\.ts$/, "layout.data.ts");
    if (dataPath !== rootLayout) {
      try {
        const mod = (await importer(dataPath)) as { load?: PageDataLoad };
        const layoutData = mod.load ? await mod.load({ params, searchParams, request: options.request }) : undefined;
        if (layoutData && typeof layoutData === "object") {
          const attrs = (layoutData as { htmlAttributes?: Record<string, string> }).htmlAttributes;
          if (attrs) Object.assign(htmlAttributes, attrs);
          const scripts = (layoutData as { headScripts?: string[] }).headScripts;
          if (Array.isArray(scripts)) headScripts.push(...scripts);
          const links = (layoutData as { headLinks?: string[] }).headLinks;
          if (Array.isArray(links)) headLinks.push(...links);
        }
      } catch {
        // The root layout loader is optional; ignore failures here.
      }
    }
  }

  return documentShell({
    title: "Loading...",
    lang: config.lang,
    body,
    data: { __elur_js_streaming: true, page: route.path },
    actions,
    htmlAttributes,
    headScripts,
    headLinks,
    clientEntry: config.clientEntry,
  });
}

export interface RenderPageBodyOptions {
  routes: ScannedRoutes;
  pathname: string;
  searchParams: URLSearchParams;
  config: Pick<BuildConfig, "lang" | "clientEntry">;
  actions?: Record<string, string[]>;
  importer?: (path: string) => Promise<unknown>;
  request?: Request;
}

export interface RenderPageBodyResult {
  /** Inner HTML body for the page (without the document shell). */
  body: string;
  /** Page title extracted from the rendered shell. */
  title: string;
  /** Full rendered document shell (used for ISR caching). */
  fullHtml?: string;
  /** `Set-Cookie` value that clears a consumed action error cookie. */
  clearActionErrorCookie?: string;
  /** `<head>` tags (title, meta, OG, twitter) for the SPA router to merge. */
  head?: string;
  /** First-class Response when a loader threw one (A-22). */
  response?: Response;
}

/** Thrown by `renderPageBody` when the requested path has no matching route. */
export class RouteNotFoundError extends Error {
  constructor(pathname: string) {
    super(`No route found for ${pathname}`);
    this.name = "RouteNotFoundError";
  }
}

/**
 * Render only the inner HTML body for a page. Used by the streaming endpoint
 * to inject the real content into the shell.
 */
export async function renderPageBody(options: RenderPageBodyOptions): Promise<RenderPageBodyResult> {
  const { routes, pathname, searchParams, config, actions, importer = defaultImport, request } = options;
  const match = matchRoute(pathname, routes.pages);
  if (!match) {
    throw new RouteNotFoundError(pathname);
  }

  const result = await renderPage({
    route: match.route,
    params: match.params,
    searchParams,
    config,
    actions,
    importer,
    request,
  });

  // If a loader threw a Response (redirect, 404, etc.), propagate it (A-22).
  if (result.response) {
    return {
      body: "",
      title: "",
      response: result.response,
    };
  }

  const bodyMatch = result.html.match(/<div id="app">([\s\S]*)<\/div>\s*(<script|$)/);
  const body = bodyMatch ? bodyMatch[1].trim() : result.html;
  const titleMatch = result.html.match(/<title[^>]*>([^<]*)<\/title>/);
  return {
    body,
    title: titleMatch ? titleMatch[1] : result.resolvedTitle ?? "",
    fullHtml: result.html,
    clearActionErrorCookie: result.clearActionErrorCookie,
    head: result.head,
  };
}
