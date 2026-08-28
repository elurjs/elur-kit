import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { scanActions, type ActionRegistry } from "../action/scan.js";
import type { ResolvedElurConfig } from "../config/index.js";
import { runIntegrationHook } from "../integrations/index.js";
import { scanIslands, type IslandModule } from "../island/scan.js";
import { scanRoutes, type ScannedRoutes } from "../router/route-scanner.js";

export interface AppManifest {
  version: 1;
  root: string;
  routes: ScannedRoutes;
  actions: ActionRegistry;
  islands: IslandModule[];
  base: string;
  output: ResolvedElurConfig["output"];
}

export async function createAppManifest(config: ResolvedElurConfig): Promise<AppManifest> {
  const [routes, actions, islands] = await Promise.all([
    scanRoutes(config.appDir),
    scanActions(config.appDir),
    scanIslands(config.islandsDir),
  ]);
  validateManifestRoutes(routes);
  validateIslands(islands);
  const manifest: AppManifest = {
    version: 1,
    root: config.root,
    routes,
    actions,
    islands,
    base: config.base,
    output: config.output,
  };
  await runIntegrationHook(config.integrations, "routes", [
    manifest,
    { root: config.root, command: "build" },
  ]);
  return manifest;
}

export async function writeAppManifest(manifest: AppManifest, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(toPortableManifest(manifest), null, 2), "utf8");
}

export async function writeRouteTypes(manifest: AppManifest, path: string): Promise<void> {
  const routePaths = manifest.routes.pages.map((route) => JSON.stringify(route.path));
  const actionNames = Object.values(manifest.actions)
    .flatMap((actions) => Object.keys(actions))
    .filter((name, index, names) => names.indexOf(name) === index)
    .map((name) => JSON.stringify(name));
  const source = [
    `export type ElurRoutePath = ${routePaths.length ? routePaths.join(" | ") : "never"};`,
    `export type ElurActionName = ${actionNames.length ? actionNames.join(" | ") : "never"};`,
    "export interface ElurRouteParams { [name: string]: string | string[] | undefined }",
    "",
  ].join("\n");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, "utf8");
}

export function validateManifestRoutes(routes: ScannedRoutes): void {
  const seen = new Map<string, string>();
  for (const route of routes.pages) {
    registerRoute(seen, route.path, route.pagePath, "page");
    assertNotReserved(route.path, route.pagePath);
  }
  for (const route of routes.api) {
    registerRoute(seen, route.path, route.routePath, "API");
    assertNotReserved(route.path, route.routePath);
  }
}

export function assertClientImportAllowed(id: string, importer?: string): void {
  if (/\.server\.[cm]?[jt]sx?$/.test(id)) {
    throw new Error(`[elur-kit] Server-only module imported by client${importer ? ` from ${importer}` : ""}: ${id}`);
  }
}

function registerRoute(seen: Map<string, string>, path: string, file: string, kind: string): void {
  const existing = seen.get(path);
  if (existing) {
    throw new Error(`[elur-kit] Duplicate ${kind} route "${path}": ${existing} and ${file}`);
  }
  seen.set(path, file);
}

function assertNotReserved(path: string, file: string): void {
  if (path === "/__elur-js" || path.startsWith("/__elur-js/") || path === "/_elur" || path.startsWith("/_elur/")) {
    throw new Error(`[elur-kit] Reserved route "${path}" declared by ${file}`);
  }
}

function validateIslands(islands: readonly IslandModule[]): void {
  const names = new Set<string>();
  for (const island of islands) {
    if (names.has(island.name)) throw new Error(`[elur-kit] Duplicate island name: ${island.name}`);
    names.add(island.name);
  }
}

function toPortableManifest(manifest: AppManifest): AppManifest {
  const relativePath = (path: string | undefined) => path ? relative(manifest.root, path).split("\\").join("/") : undefined;
  const routes: ScannedRoutes = {
    pages: manifest.routes.pages.map((route) => ({
      ...route,
      pagePath: relativePath(route.pagePath)!,
      dataPath: relativePath(route.dataPath),
      actionPath: relativePath(route.actionPath),
      loadingPath: relativePath(route.loadingPath),
      layouts: route.layouts.map((layout) => relativePath(layout)!),
    })),
    api: manifest.routes.api.map((route) => ({ ...route, routePath: relativePath(route.routePath)! })),
    error404: manifest.routes.error404 ? {
      ...manifest.routes.error404,
      pagePath: relativePath(manifest.routes.error404.pagePath)!,
      dataPath: relativePath(manifest.routes.error404.dataPath),
      actionPath: relativePath(manifest.routes.error404.actionPath),
      loadingPath: relativePath(manifest.routes.error404.loadingPath),
      layouts: manifest.routes.error404.layouts.map((layout) => relativePath(layout)!),
    } : undefined,
    error500: manifest.routes.error500 ? {
      ...manifest.routes.error500,
      pagePath: relativePath(manifest.routes.error500.pagePath)!,
      dataPath: relativePath(manifest.routes.error500.dataPath),
      actionPath: relativePath(manifest.routes.error500.actionPath),
      loadingPath: relativePath(manifest.routes.error500.loadingPath),
      layouts: manifest.routes.error500.layouts.map((layout) => relativePath(layout)!),
    } : undefined,
  };
  const actions: ActionRegistry = {};
  for (const [page, pageActions] of Object.entries(manifest.actions)) {
    actions[page] = Object.fromEntries(
      Object.entries(pageActions).map(([name, path]) => [name, relativePath(path)!]),
    );
  }
  return {
    ...manifest,
    root: ".",
    routes,
    actions,
    islands: manifest.islands.map((island) => ({ ...island, filePath: relativePath(island.filePath)! })),
  };
}
