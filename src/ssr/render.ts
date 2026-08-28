import type { ElurTemplate } from "@elurjs/core";
import { renderToString } from "../render/render-to-string.js";
import { documentShell, buildHeadTags } from "../build/document-shell.js";
import type { PageRoute, ScannedRoutes } from "../router/route-scanner.js";
import type { BuildConfig } from "../build/build.js";
import type { PageDataLoad, PageProps, RouteParams, PageMetadata, GenerateMetadata } from "../types.js";
import { existsSync } from "node:fs";
import { decodeActionErrorCookie, ACTION_ERROR_COOKIE } from "../action/error-store.js";
import { normalizeCachePolicy, type CachePolicy } from "../cache/policy.js";

export interface RenderPageOptions {
  route: PageRoute;
  params?: RouteParams;
  searchParams?: URLSearchParams;
  config: Pick<BuildConfig, "lang" | "clientEntry" | "renderEndpoint">;
  /** Custom module loader. Defaults to native dynamic import. */
  importer?: (path: string) => Promise<unknown>;
  /** Per-page action names exposed in the HTML shell. */
  actions?: Record<string, string[]>;
  /** Current request, used to hydrate data loaders that need cookies/headers. */
  request?: Request;
}

export interface RenderPageResult {
  html: string;
  revalidate?: number;
  /**
   * `Set-Cookie` header value that clears the action error cookie, when the
   * page consumed a relayed action failure. The SSR server should append it to
   * the outgoing response so the cookie does not persist.
   */
  clearActionErrorCookie?: string;
  /** `<head>` tags (title, meta, OG, twitter) for the SPA router to merge. */
  head?: string;
  /** Resolved page title (from metadata or fallback). */
  resolvedTitle?: string;
  /**
   * When a loader or layout throws a `Response` (e.g. `throw new Response(...,
   * { status: 404 })`), it is captured here as a first-class response instead
   * of being treated as an internal error (A-22).
   */
  response?: Response;
  /** HTTP status code for the rendered page (e.g. 404 for not-found pages). */
  status?: number;
  /** Cache policy declared by the route (§9.1). */
  cachePolicy?: CachePolicy;
}

const defaultImport = (path: string) => import(path);

/**
 * Collects `<html>` attributes and head scripts declared by data loaders
 * (page and layouts) via top-level `htmlAttributes` / `headScripts` fields.
 */
export function collectShellExtras(
  pageData: unknown,
  layoutDataList: unknown[],
): { htmlAttributes: Record<string, string>; headScripts: string[]; headLinks: string[] } {
  const htmlAttributes: Record<string, string> = {};
  const headScripts: string[] = [];
  const headLinks: string[] = [];
  const merge = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const attrs = (value as { htmlAttributes?: Record<string, string> }).htmlAttributes;
    if (attrs) Object.assign(htmlAttributes, attrs);
    const scripts = (value as { headScripts?: string[] }).headScripts;
    if (Array.isArray(scripts)) headScripts.push(...scripts);
    const links = (value as { headLinks?: string[] }).headLinks;
    if (Array.isArray(links)) headLinks.push(...links);
  };
  for (const layoutData of layoutDataList) merge(layoutData);
  merge(pageData);
  // Deduplicate headScripts and headLinks (e.g. from both layout and page data)
  const uniqueScripts = [...new Set(headScripts)];
  const uniqueLinks = [...new Set(headLinks)];
  return { htmlAttributes, headScripts: uniqueScripts, headLinks: uniqueLinks };
}

export async function renderPage(options: RenderPageOptions): Promise<RenderPageResult> {
  const { route, params = {}, searchParams = new URLSearchParams(), config, importer = defaultImport, actions, request } = options;

  const pageModule = await importer(route.pagePath) as {
    default: (props: PageProps<unknown>) => ElurTemplate;
    generateMetadata?: GenerateMetadata;
  };
  const { default: PageComponent, generateMetadata } = pageModule;

  let data: unknown;
  let revalidate: number | undefined;
  let cachePolicy: import("../cache/policy.js").CachePolicy | undefined;
  // Use a mutable container so TypeScript doesn't narrow the type after
  // the first `if (thrownResponse)` check.
  const thrown: { response: Response | undefined } = { response: undefined };
  if (route.dataPath) {
    const mod = await importer(route.dataPath) as {
      load?: PageDataLoad;
      revalidate?: number;
      cache?: unknown;
    };
    if (mod.load) {
      try {
        data = await mod.load({ params, searchParams, request });
      } catch (err) {
        if (err instanceof Response) {
          thrown.response = err;
        } else {
          throw err;
        }
      }
    }
    if (typeof mod.revalidate === "number") {
      revalidate = mod.revalidate;
    }
    // Read cache policy from the data module (§9.1).
    if (mod.cache) {
      cachePolicy = normalizeCachePolicy(mod.cache);
      if (cachePolicy.revalidate > 0) {
        revalidate = cachePolicy.revalidate;
      }
    }
  }

  // If a loader threw a Response (redirect, 404, etc.), return it as a
  // first-class response instead of rendering the page (A-22).
  if (thrown.response) {
    return { html: "", response: thrown.response, status: thrown.response.status };
  }

  // Relay an action failure previously stored in the ephemeral cookie so the
  // page can render validation errors via `props.form`. The cookie is cleared
  // on the outgoing response (see `clearActionErrorCookie` in the result).
  let form: unknown;
  let clearActionErrorCookie: string | undefined;
  if (request) {
    const cookieHeader = request.headers.get("Cookie") ?? "";
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${ACTION_ERROR_COOKIE}=([^;]+)`));
    if (match) {
      const decoded = decodeActionErrorCookie(match[1]);
      if (decoded) {
        form = { __elur_js_action_error: true, status: decoded.status, data: decoded.data };
        clearActionErrorCookie = `${ACTION_ERROR_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
      }
    }
  }

  const props: PageProps<unknown> = {
    data: data ?? {},
    params,
    searchParams,
    form,
  };

  const layoutModules = await Promise.all(
    route.layouts.map(async (layoutPath) => importer(layoutPath)),
  );
  const layoutDataList = await Promise.all(
    route.layouts.map(async (layoutPath) => {
      const dataPath = layoutPath.replace(/layout\.ts$/, "layout.data.ts");
      if (!existsSync(dataPath)) return undefined;
      const mod = (await importer(dataPath)) as { load?: PageDataLoad };
      if (mod.load) {
        try {
          return await mod.load({ params, searchParams, request });
        } catch (err) {
          if (err instanceof Response) {
            thrown.response = err;
            return undefined;
          }
          throw err;
        }
      }
      return undefined;
    }),
  );

  // If a layout loader threw a Response, return it as first-class (A-22).
  const layoutThrown = thrown.response as Response | undefined;
  if (layoutThrown) {
    return { html: "", response: layoutThrown, status: layoutThrown.status };
  }

  // Load slot modules if the route has them (v2.1 — Fix #2: Layout Slots).
  let slotTemplates: Record<string, ElurTemplate> | undefined;
  if (route.slots) {
    slotTemplates = {};
    for (const [slotName, slotPath] of Object.entries(route.slots)) {
      const slotMod = await importer(slotPath) as { default: (props: PageProps<unknown>) => ElurTemplate };
      slotTemplates[slotName] = slotMod.default(props);
    }
  }

  const body = await renderToString(() => {
    let template = PageComponent(props);
    for (let i = layoutModules.length - 1; i >= 0; i--) {
      const { default: Layout } = layoutModules[i] as {
        default: (props: { children: ElurTemplate; data?: unknown; slots?: Record<string, ElurTemplate> }) => ElurTemplate;
      };
      template = Layout({ children: template, data: layoutDataList[i], slots: slotTemplates });
    }
    return template;
  });

  const title = typeof data === "object" && data && "title" in data
    ? String((data as { title?: unknown }).title ?? "Elur Kit")
    : "Elur Kit";

  const { htmlAttributes, headScripts, headLinks } = collectShellExtras(data, layoutDataList);

  // Resolve page metadata. Priority: `generateMetadata` from page.ts > `metadata`
  // field in the page loader data > `metadata` field in layout loader data.
  let metadata: PageMetadata | undefined;
  if (typeof generateMetadata === "function") {
    metadata = await generateMetadata({ params, searchParams, request, data });
  }
  if (!metadata) {
    metadata = extractMetadata(data) ?? extractMetadataFromList(layoutDataList);
  }
  // The title from metadata takes precedence over the data.title fallback.
  const resolvedTitle = metadata?.title ?? title;

  const html = documentShell({
    title: resolvedTitle,
    lang: config.lang,
    body,
    data,
    actions,
    htmlAttributes,
    headScripts,
    headLinks,
    metadata,
    clientEntry: config.clientEntry,
    renderEndpoint: config.renderEndpoint,
  });

  const head = metadata ? buildHeadTags(metadata, resolvedTitle) : "";
  return { html, revalidate, clearActionErrorCookie, head, resolvedTitle, cachePolicy };
}

/** Extracts a `metadata` field from a loader data object, if present. */
function extractMetadata(value: unknown): PageMetadata | undefined {
  if (value && typeof value === "object" && "metadata" in value) {
    const meta = (value as { metadata?: unknown }).metadata;
    if (meta && typeof meta === "object") return meta as PageMetadata;
  }
  return undefined;
}

/** Extracts metadata from the first layout data object that has one. */
function extractMetadataFromList(list: unknown[]): PageMetadata | undefined {
  for (const item of list) {
    const meta = extractMetadata(item);
    if (meta) return meta;
  }
  return undefined;
}

export interface RenderErrorPageOptions {
  routes: ScannedRoutes;
  status: 404 | 500;
  error?: unknown;
  config: Pick<BuildConfig, "lang" | "clientEntry" | "renderEndpoint">;
  actions?: Record<string, string[]>;
  importer?: (path: string) => Promise<unknown>;
}

export async function renderErrorPage(
  options: RenderErrorPageOptions,
): Promise<{ html: string; status: number } | undefined> {
  const route = options.status === 404 ? options.routes.error404 : options.routes.error500;
  if (!route) return undefined;

  try {
    const { html } = await renderPage({
      route,
      params: {},
      searchParams: new URLSearchParams(),
      config: options.config,
      actions: options.actions,
      importer: options.importer,
    });
    return { html, status: options.status };
  } catch (err) {
    console.error(`[render] error ${options.status} page failed`, err);
    return undefined;
  }
}
