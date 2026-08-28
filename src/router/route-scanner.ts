import { readdir } from "node:fs/promises";
import { join } from "node:path";

// --- Route scanner ---
//
// Walks src/app/ and maps file conventions to URL paths.
//
// Supported conventions:
//   - page.ts          -> URL path
//   - page.data.ts     -> loader for that page
//   - layout.ts        -> layout wrapping pages in the same segment
//   - route.ts         -> API endpoint (collected separately)
//
// Dynamic segments:
//   - [slug]           -> :slug
//   - [...slug]        -> catch-all (rendered as :slug*)
//   - [[...slug]]      -> optional catch-all (rendered as :slug* but matches
//                         the base path too)
//
// Route conflicts (two routes with the same path pattern) cause an error
// during scanRoutes (plan §11.1).

/** A page route discovered by the scanner. */
export interface PageRoute {
  /** URL path, e.g. "/blog/:slug". */
  path: string;
  /** File system path to the page.ts module. */
  pagePath: string;
  /** File system path to the page.data.ts module, if any. */
  dataPath?: string;
  /** File system path to the page.action.ts module, if any. */
  actionPath?: string;
  /** Ordered list of layout.ts modules from root to leaf. */
  layouts: string[];
  /** File system path to the loading.ts module, if any. */
  loadingPath?: string;
  /** Dynamic parameter names extracted from the path. */
  params: string[];
  /** Whether the route has an optional catch-all segment. */
  optionalCatchAll?: boolean;
  /**
   * Named slot modules discovered in the same directory as the page.
   * Keyed by slot name (filename without `.slot.ts` suffix).
   * (v2.1 — Fix #2: Layout Slots)
   */
  slots?: Record<string, string>;
}

/** An API route discovered by the scanner. */
export interface ApiRoute {
  /** URL path, e.g. "/api/posts". */
  path: string;
  /** File system path to the route.ts module. */
  routePath: string;
  /** Dynamic parameter names extracted from the path. */
  params: string[];
}

/** Result of scanning the app directory. */
export interface ScannedRoutes {
  pages: PageRoute[];
  api: ApiRoute[];
  /** Optional 404 error page. */
  error404?: PageRoute;
  /** Optional 500 error page. */
  error500?: PageRoute;
}

function isRouteGroup(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

function segmentToUrl(segment: string): string {
  // Optional catch-all: [[...slug]] -> :slug* (matches base path too)
  if (segment.startsWith("[[...") && segment.endsWith("]]")) {
    return `:${segment.slice(5, -2)}*`;
  }
  // Catch-all: [...slug] -> :slug*
  if (segment.startsWith("[...") && segment.endsWith("]")) {
    return `:${segment.slice(4, -1)}*`;
  }
  // Dynamic: [slug] -> :slug
  if (segment.startsWith("[") && segment.endsWith("]")) {
    return `:${segment.slice(1, -1)}`;
  }
  return segment;
}

function extractParams(segment: string): string[] {
  if (segment.startsWith("[[...") && segment.endsWith("]]")) {
    return [segment.slice(5, -2)];
  }
  if (segment.startsWith("[...") && segment.endsWith("]")) {
    return [segment.slice(4, -1)];
  }
  if (segment.startsWith("[") && segment.endsWith("]")) {
    return [segment.slice(1, -1)];
  }
  return [];
}

function isOptionalCatchAll(segment: string): boolean {
  return segment.startsWith("[[...") && segment.endsWith("]]");
}

async function collectFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function collectDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function scanRecursive(
  appDir: string,
  currentDir: string,
  urlSegments: string[],
  params: string[],
  layouts: string[],
  result: ScannedRoutes,
  hasOptionalCatchAll = false,
): Promise<void> {
  const files = await collectFiles(currentDir);
  const dirs = await collectDirs(currentDir);

  const pagePath = files.includes("page.ts")
    ? join(currentDir, "page.ts")
    : undefined;
  const dataPath = files.includes("page.data.ts")
    ? join(currentDir, "page.data.ts")
    : undefined;
  const actionPath = files.includes("page.action.ts")
    ? join(currentDir, "page.action.ts")
    : undefined;
  const loadingPath = files.includes("loading.ts")
    ? join(currentDir, "loading.ts")
    : undefined;
  const layoutPath = files.includes("layout.ts")
    ? join(currentDir, "layout.ts")
    : undefined;
  const routePath = files.includes("route.ts")
    ? join(currentDir, "route.ts")
    : undefined;

  const currentLayouts = layoutPath
    ? [...layouts, layoutPath]
    : [...layouts];

  if (routePath) {
    result.api.push({
      path: urlSegments.length === 0 ? "/" : "/" + urlSegments.join("/"),
      routePath,
      params: [...params],
    });
  }

  if (pagePath) {
    const path = urlSegments.length === 0 ? "/" : "/" + urlSegments.join("/");
    // Detect named slot files: *.slot.ts (v2.1 — Fix #2: Layout Slots)
    const slots: Record<string, string> = {};
    for (const file of files) {
      const slotMatch = file.match(/^(.+)\.slot\.ts$/);
      if (slotMatch) {
        slots[slotMatch[1]] = join(currentDir, file);
      }
    }
    result.pages.push({
      path,
      pagePath,
      dataPath,
      actionPath,
      layouts: currentLayouts,
      loadingPath,
      params: [...params],
      optionalCatchAll: hasOptionalCatchAll,
      slots: Object.keys(slots).length > 0 ? slots : undefined,
    });
  }

  for (const dir of dirs) {
    if (isRouteGroup(dir)) {
      // Route groups do not add a URL segment, but they can add a layout.
      const groupDir = join(currentDir, dir);
      const groupFiles = await collectFiles(groupDir);
      const groupLayout = groupFiles.includes("layout.ts")
        ? join(groupDir, "layout.ts")
        : undefined;
      await scanRecursive(
        appDir,
        groupDir,
        urlSegments,
        params,
        groupLayout ? [...currentLayouts, groupLayout] : currentLayouts,
        result,
      );
      continue;
    }

    const optional = isOptionalCatchAll(dir);
    await scanRecursive(
      appDir,
      join(currentDir, dir),
      [...urlSegments, segmentToUrl(dir)],
      [...params, ...extractParams(dir)],
      currentLayouts,
      result,
      optional,
    );
  }
}

/**
 * Scans an app directory for Elur Kit file-based routes.
 *
 * @param appDir Absolute path to the app directory (e.g. "src/app").
 * @returns Discovered page and API routes.
 */
export async function scanRoutes(appDir: string): Promise<ScannedRoutes> {
  const result: ScannedRoutes = { pages: [], api: [] };
  const rootFiles = await collectFiles(appDir);
  const rootLayout = rootFiles.includes("layout.ts")
    ? join(appDir, "layout.ts")
    : undefined;

  if (rootFiles.includes("404.page.ts")) {
    result.error404 = {
      path: "/404",
      pagePath: join(appDir, "404.page.ts"),
      dataPath: rootFiles.includes("404.page.data.ts")
        ? join(appDir, "404.page.data.ts")
        : undefined,
      layouts: rootLayout ? [rootLayout] : [],
      params: [],
    };
  }

  if (rootFiles.includes("500.page.ts")) {
    result.error500 = {
      path: "/500",
      pagePath: join(appDir, "500.page.ts"),
      dataPath: rootFiles.includes("500.page.data.ts")
        ? join(appDir, "500.page.data.ts")
        : undefined,
      layouts: rootLayout ? [rootLayout] : [],
      params: [],
    };
  }

  await scanRecursive(appDir, appDir, [], [], [], result);

  // Detect route conflicts (plan §11.1): two routes with the same path
  // pattern is an error during manifest generation.
  detectRouteConflicts(result);

  return result;
}

/**
 * Detects and throws on route conflicts (plan §11.1, runtime-security §10).
 * Two routes with the same path pattern cause an error.
 */
function detectRouteConflicts(routes: ScannedRoutes): void {
  const pagePaths = new Map<string, string>();
  for (const page of routes.pages) {
    const existing = pagePaths.get(page.path);
    if (existing) {
      throw new Error(
        `[elur-kit] Route conflict: "${page.path}" is defined by both ` +
        `"${existing}" and "${page.pagePath}". ` +
        `Remove one of the conflicting page.ts files.`,
      );
    }
    pagePaths.set(page.path, page.pagePath);
  }

  // Also check API route conflicts.
  const apiPaths = new Map<string, string>();
  for (const api of routes.api) {
    const existing = apiPaths.get(api.path);
    if (existing) {
      throw new Error(
        `[elur-kit] API route conflict: "${api.path}" is defined by both ` +
        `"${existing}" and "${api.routePath}".`,
      );
    }
    apiPaths.set(api.path, api.routePath);
  }
}
