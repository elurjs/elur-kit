import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { scanRoutes, type PageRoute, type ScannedRoutes } from "../router/route-scanner.js";
import { scanIslands, type IslandModule } from "../island/scan.js";
import { generateClientEntry } from "../island/generate-entry.js";
import { renderPage, renderErrorPage } from "../ssr/render.js";
import { scanActions, actionNames } from "../action/scan.js";
import { consumeImageRegistry, setImageManifest, type ImageFormat } from "../image/index.js";
import { processImageBatch, type ImageManifest } from "../image/service.js";
import { runIntegrationHook, type NixKitIntegration } from "../integrations/index.js";
import type { RouteParams, GenerateStaticParams } from "../types.js";

export interface BuildConfig {
  /** Absolute path to the app directory (e.g. /project/src/app). */
  appDir: string;
  /** Absolute path to the output directory (e.g. /project/dist). */
  outDir: string;
  /** Absolute path to the project root (e.g. /project). When provided, action
   * paths in the serialized HTML shell are made relative to this root. */
  root?: string;
  /** Base path for the client entry module, e.g. "/_nix-js/entry-client.js". */
  clientEntry?: string;
  /** Default language for the HTML shell. */
  lang?: string;
  /**
   * Absolute path to the islands directory (e.g. /project/src/islands).
   * When set, `build` scans it and generates a client entry module listing
   * every island so you don't have to maintain `entry-client.ts` by hand.
   */
  islandsDir?: string;
  /**
   * Absolute path where the generated client entry module is written
   * (e.g. /project/.nix-js/entry-client.ts). Required when `islandsDir` is set.
   */
  generatedEntry?: string;
  /**
   * Import specifier the generated entry uses for `hydrateIslands`.
   * Defaults to the published subpath `@deijose/nix-js-kit/island`.
   */
  hydrateImport?: string;
  /**
   * Import specifier the generated entry uses for `startClientRouter`.
   * Defaults to the published subpath `@deijose/nix-js-kit/router`.
   */
  routerImport?: string;
  /** Absolute path to the public directory for static assets (optional). */
  publicDir?: string;
  /** Image formats to generate when sharp is available. Defaults to ["webp", "avif"]. */
  imageFormats?: ImageFormat[];
  /**
   * Whether the SSR render endpoint (`/__nix-js/render`) exists at runtime.
   * Defaults to `true` (dev, preview and SSR deployments). Set to `false` for
   * fully static outputs so the emitted HTML tells the client router to skip
   * the endpoint (no 404 storms on static hosts like Vercel).
   */
  renderEndpoint?: boolean;
  /**
   * Integrations to invoke during the build lifecycle. When provided, the
   * `build` hook fires after all pages and image variants are generated,
   * giving integrations a chance to write post-build artifacts (sitemaps,
   * robots.txt, search indexes, etc.) into the output directory.
   */
  integrations?: NixKitIntegration[];
}

export interface BuildResult {
  /** Number of static HTML pages generated. */
  pages: number;
  /** Paths that were skipped because they are dynamic without a static param list. */
  skipped: string[];
  /** Absolute paths to the generated HTML files. */
  files: string[];
  /** Islands discovered when `islandsDir` is set. */
  islands: IslandModule[];
  /** Absolute path to the generated client entry, if one was written. */
  generatedEntry?: string;
  /** Number of image variants generated (0 if sharp is not installed). */
  imagesProcessed: number;
}

function urlToFilePath(outDir: string, urlPath: string): string {
  if (urlPath === "/") {
    return join(outDir, "index.html");
  }

  const segments = urlPath.slice(1).split("/");
  return join(outDir, ...segments, "index.html");
}

function isDynamic(path: string): boolean {
  return path.includes(":");
}

function buildConcreteUrl(path: string, params: RouteParams): string {
  return path.replace(/:([a-zA-Z0-9_]+)(\*)?/g, (_, name, catchAll) => {
    const value = params[name];
    if (value === undefined || value === null) {
      throw new Error(
        `Missing value for dynamic segment "${name}" in path "${path}"`,
      );
    }
    if (catchAll) {
      return Array.isArray(value) ? value.join("/") : String(value);
    }
    return String(value);
  });
}

/**
 * Builds a static site from a scanned route tree.
 *
 * @param config Build configuration.
 * @returns Summary of generated files.
 */
export async function build(config: BuildConfig): Promise<BuildResult> {
  if (config.publicDir) {
    try {
      if ((await stat(config.publicDir)).isDirectory()) {
        await mkdir(config.outDir, { recursive: true });
        await cp(config.publicDir, config.outDir, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const routes = await scanRoutes(config.appDir);
  const actions = await scanActions(config.appDir);
  // Only action names are serialized into the HTML shell; full paths stay on the server.
  const publicActions = actionNames(actions);
  const result: BuildResult = { pages: 0, skipped: [], files: [], islands: [], imagesProcessed: 0 };

  // Scan islands and generate the client entry before rendering pages, so the
  // hydration bundle stays in sync with what the app actually uses.
  if (config.islandsDir) {
    result.islands = await scanIslands(config.islandsDir);
  }

  if (config.generatedEntry) {
    result.generatedEntry = await generateClientEntry({
      islands: result.islands,
      outFile: config.generatedEntry,
      hydrateImport: config.hydrateImport,
      routerImport: config.routerImport,
    });
  }

  for (const route of routes.pages) {
    if (!isDynamic(route.path)) {
      const filePath = await buildPage(config, route, publicActions);
      result.pages++;
      result.files.push(filePath);
      continue;
    }

    const dynamicFiles = await buildDynamicPages(config, route, publicActions);
    if (dynamicFiles.length === 0) {
      result.skipped.push(route.path);
    } else {
      result.pages += dynamicFiles.length;
      result.files.push(...dynamicFiles);
    }
  }

  // Generate static 404 and 500 error pages when they exist.
  const errorConfig = { lang: config.lang, clientEntry: config.clientEntry, renderEndpoint: false };
  if (routes.error404) {
    const result404 = await renderErrorPage({
      routes,
      status: 404,
      config: errorConfig,
      actions: publicActions,
    });
    if (result404) {
      const filePath = join(config.outDir, "404.html");
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, result404.html, "utf8");
      result.files.push(filePath);
    }
  }

  if (routes.error500) {
    const result500 = await renderErrorPage({
      routes,
      status: 500,
      config: errorConfig,
      actions: publicActions,
    });
    if (result500) {
      const filePath = join(config.outDir, "500.html");
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, result500.html, "utf8");
      result.files.push(filePath);
    }
  }

  // Process registered images with the ImageService (if sharp is installed).
  // This is a two-pass process:
  //   1. First render pass registers all images (already done above).
  //   2. Process registered images → produce manifest.
  //   3. If variants were generated, set the manifest and re-render pages
  //      so the markup uses real <picture>/<source> with hashed URLs.
  const registeredImages = consumeImageRegistry();
  let manifest: ImageManifest | null = null;
  if (registeredImages.length > 0 && config.publicDir) {
    const manifestPath = join(config.outDir, ".nix-js", "image-manifest.json");
    const processResult = await processImageBatch(registeredImages, {
      publicDir: config.publicDir,
      outDir: config.outDir,
      formats: config.imageFormats,
      manifestPath,
    });
    result.imagesProcessed = processResult.count;

    if (processResult.optimized && processResult.count > 0) {
      manifest = processResult.manifest;
      setImageManifest(manifest);

      // Re-render all pages with the manifest so image() emits <picture>.
      result.pages = 0;
      result.files = [];
      for (const route of routes.pages) {
        if (!isDynamic(route.path)) {
          const filePath = await buildPage(config, route, publicActions);
          result.pages++;
          result.files.push(filePath);
          continue;
        }
        const dynamicFiles = await buildDynamicPages(config, route, publicActions);
        if (dynamicFiles.length === 0) {
          result.skipped.push(route.path);
        } else {
          result.pages += dynamicFiles.length;
          result.files.push(...dynamicFiles);
        }
      }

      // Re-render error pages too.
      if (routes.error404) {
        const result404 = await renderErrorPage({
          routes,
          status: 404,
          config: errorConfig,
          actions: publicActions,
        });
        if (result404) {
          const filePath = join(config.outDir, "404.html");
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, result404.html, "utf8");
          result.files.push(filePath);
        }
      }
      if (routes.error500) {
        const result500 = await renderErrorPage({
          routes,
          status: 500,
          config: errorConfig,
          actions: publicActions,
        });
        if (result500) {
          const filePath = join(config.outDir, "500.html");
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, result500.html, "utf8");
          result.files.push(filePath);
        }
      }
    }
  }

  // Clear the manifest so subsequent builds start fresh.
  setImageManifest(null);

  // Fire the `build` integration hook so integrations can write
  // post-build artifacts (sitemaps, robots.txt, search indexes, etc.)
  // into the output directory. This runs after all pages, image variants,
  // and the manifest are written, but before the atomic staging commit
  // (when called via the CLI), so integration artifacts survive the swap.
  if (config.integrations && config.integrations.length > 0) {
    await runIntegrationHook(config.integrations, "build", [
      result,
      { root: config.root ?? config.outDir, command: "build" },
    ]);
  }

  return result;
}

async function buildPage(
  config: BuildConfig,
  route: PageRoute,
  actions: Record<string, string[]>,
): Promise<string> {
  return buildConcretePage(config, route, {}, actions);
}

async function buildDynamicPages(
  config: BuildConfig,
  route: PageRoute,
  actions: Record<string, string[]>,
): Promise<string[]> {
  const { generateStaticParams } = (await import(
    route.pagePath
  )) as { generateStaticParams?: GenerateStaticParams };

  if (!generateStaticParams) {
    return [];
  }

  const paramList = await generateStaticParams();
  if (!Array.isArray(paramList) || paramList.length === 0) {
    return [];
  }

  const files: string[] = [];
  for (const params of paramList) {
    files.push(await buildConcretePage(config, route, params, actions));
  }
  return files;
}

async function buildConcretePage(
  config: BuildConfig,
  route: PageRoute,
  params: RouteParams,
  actions: Record<string, string[]>,
): Promise<string> {
  const { html: htmlOut } = await renderPage({
    route,
    params,
    searchParams: new URLSearchParams(),
    config: { lang: config.lang, clientEntry: config.clientEntry, renderEndpoint: false },
    actions,
  });

  const urlPath = isDynamic(route.path) ? buildConcreteUrl(route.path, params) : route.path;
  const filePath = urlToFilePath(config.outDir, urlPath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, htmlOut, "utf8");

  return filePath;
}

export { scanRoutes, type PageRoute, type ScannedRoutes };
