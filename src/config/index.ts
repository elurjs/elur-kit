import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { loadConfigFromFile } from "vite";
import type { Adapter } from "../adapters/index.js";
import type { ImageFormat } from "../image/index.js";
import type { ElurKitIntegration } from "../integrations/index.js";
import { runIntegrationHook } from "../integrations/index.js";
import type { LogLevel } from "../runtime/logger.js";
import type { CacheAdapter } from "../cache/adapter.js";
import type { RedirectRule, RewriteRule, RouteHeadersRule } from "../router/redirects.js";

export type ElurOutputMode = "static" | "server" | "hybrid";
export type TrailingSlashMode = "always" | "never" | "ignore";

export interface ElurConfig {
  root?: string;
  appDir?: string;
  islandsDir?: string;
  contentDir?: string;
  publicDir?: string;
  outDir?: string;
  site?: string;
  base?: string;
  trailingSlash?: TrailingSlashMode;
  output?: ElurOutputMode;
  adapter?: Adapter;
  images?: {
    formats?: ImageFormat[];
    quality?: number;
    strict?: boolean;
  };
  cache?: {
    dir?: string;
    defaultRevalidate?: number;
    /**
     * Pluggable ISR cache adapter (programmatic only — not serializable).
     * Default: filesystem adapter rooted at `cache.dir`.
     */
    adapter?: CacheAdapter;
  };
  security?: {
    allowedOrigins?: string[];
    strictOrigin?: boolean;
    bodyLimit?: number;
    /** Security response headers. Set to `false` to disable defaults. */
    headers?: SecurityHeadersConfig | false;
  };
  /**
   * Client-side router options.
   */
  router?: {
    /**
     * Enable the SPA router on the client (default: `true`). When `false`,
     * no router code is generated and pages without islands ship 0 KB of
     * client JavaScript.
     */
    enabled?: boolean;
    /**
     * Enable link prefetching on hover/focus/pointerdown (default: `true`).
     * Prefetch already opts out on Save-Data and 2g-class connections.
     */
    prefetch?: boolean;
    /**
     * Swap `#app` via idiomorph DOM morphing instead of replacing children
     * (default: `false`, experimental). Hydrated islands and
     * `data-elur-persist` nodes are treated as opaque.
     */
    morph?: boolean;
    /**
     * Emit a `<script type="speculationrules">` block on statically built
     * pages (default: off). Chromium-only progressive enhancement; other
     * browsers ignore it.
     */
    speculation?: "prefetch" | "prerender";
    /**
     * Show a minimal top progress bar on SPA navigations slower than
     * ~200 ms (default: `false`).
     */
    loadingIndicator?: boolean;
  };
  /**
   * Client JavaScript emission mode (default: `"modern"`).
   *
   * - `"modern"`: per-page gating — pages without islands emit only the
   *   router chunk (or nothing when `router.enabled: false`), and split
   *   client builds emit `entry-client.js` + `router.js` separately.
   * - `"legacy"`: escape hatch restoring the pre-0%-JS behavior — the
   *   combined client entry (hydration + router) is emitted unconditionally
   *   on every page.
   */
  js?: "modern" | "legacy";
  logger?: {
    /** Minimum log level. Default: "info" in production, "debug" otherwise. */
    level?: LogLevel;
  };
  /** Redirect rules (first match wins; default status 308). */
  redirects?: RedirectRule[];
  /**
   * Opt-in streaming SSR (experimental). When `true`, dynamic routes with a
   * `loading` boundary stream the document shell immediately and swap in the
   * resolved content as a follow-up chunk. Streamed pages bypass the ISR
   * cache. Default: `false` (fully buffered rendering).
   */
  streaming?: boolean;
  /** Rewrite rules: transparently change the pathname before routing. */
  rewrites?: RewriteRule[];
  /** Extra response headers applied to matching request paths. */
  headers?: RouteHeadersRule[];
  integrations?: ElurKitIntegration[];
}

/** Security headers configuration (runtime-security §14). */
export interface SecurityHeadersConfig {
  /** X-Content-Type-Options: nosniff. Default: true. */
  noSniff?: boolean;
  /** Referrer-Policy. Default: "strict-origin-when-cross-origin". */
  referrerPolicy?: string;
  /**
   * Content-Security-Policy. Set to a string to enable.
   * Use "nonce" placeholder to inject per-request nonces.
   */
  contentSecurityPolicy?: string;
  /** Strict-Transport-Security. Only applied under HTTPS. Default: unset. */
  hsts?: string | true;
  /** X-Frame-Options or CSP frame-ancestors. Default: "SAMEORIGIN". */
  frameAncestors?: string;
  /** Permissions-Policy. Default: unset. */
  permissionsPolicy?: string;
}

export interface ResolvedElurConfig {
  root: string;
  appDir: string;
  islandsDir: string;
  contentDir: string;
  publicDir: string;
  outDir: string;
  site?: string;
  base: string;
  trailingSlash: TrailingSlashMode;
  output: ElurOutputMode;
  adapter?: Adapter;
  images: {
    formats: ImageFormat[];
    quality: number;
    strict: boolean;
  };
  cache: {
    dir: string;
    defaultRevalidate?: number;
    adapter?: CacheAdapter;
  };
  security: {
    allowedOrigins: string[];
    strictOrigin: boolean;
    bodyLimit: number;
    headers: SecurityHeadersConfig | false;
  };
  router: {
    enabled: boolean;
    prefetch: boolean;
    morph: boolean;
    speculation?: "prefetch" | "prerender";
    loadingIndicator: boolean;
  };
  /** Client JS emission mode: "modern" (0% JS gating) or "legacy". */
  js: "modern" | "legacy";
  logger: {
    level?: LogLevel;
  };
  redirects: RedirectRule[];
  rewrites: RewriteRule[];
  /** Opt-in streaming SSR (experimental). Default: `false`. */
  streaming: boolean;
  headers: RouteHeadersRule[];
  integrations: ElurKitIntegration[];
  configFile?: string;
}

export interface LoadElurConfigOptions {
  root?: string;
  configFile?: string;
  command?: "dev" | "build" | "preview" | "start" | "check" | "routes" | "doctor";
  mode?: string;
  overrides?: ElurConfig;
}

export function defineConfig(config: ElurConfig): ElurConfig {
  return config;
}

export async function loadElurConfig(options: LoadElurConfigOptions = {}): Promise<ResolvedElurConfig> {
  const initialRoot = resolve(options.root ?? process.cwd());
  const configFile = options.configFile
    ? resolve(initialRoot, options.configFile)
    : await findConfigFile(initialRoot);
  let loaded: ElurConfig = {};

  if (configFile) {
    const result = await loadConfigFromFile(
      { command: options.command === "build" ? "build" : "serve", mode: options.mode ?? "development" },
      configFile,
      initialRoot,
    );
    if (!result) throw new Error(`[elur-kit] Could not load config: ${configFile}`);
    loaded = result.config as ElurConfig;
  }

  const merged = mergeConfig(loaded, options.overrides ?? {});
  const root = resolve(initialRoot, merged.root ?? ".");
  const resolved = resolveConfig(root, merged, configFile);
  await runIntegrationHook(resolved.integrations, "config", [
    resolved as unknown as Record<string, unknown>,
    { root, command: options.command ?? "dev" },
  ]);
  return resolved;
}

function resolveConfig(root: string, config: ElurConfig, configFile?: string): ResolvedElurConfig {
  if (config.site) new URL(config.site);
  const base = normalizeBase(config.base ?? "/");
  const imageQuality = config.images?.quality ?? 80;
  if (!Number.isFinite(imageQuality) || imageQuality < 1 || imageQuality > 100) {
    throw new Error("[elur-kit] images.quality must be between 1 and 100");
  }

  return {
    root,
    appDir: resolveInside(root, config.appDir ?? "src/app", "appDir"),
    islandsDir: resolveInside(root, config.islandsDir ?? "src/islands", "islandsDir"),
    contentDir: resolveInside(root, config.contentDir ?? "src/content", "contentDir"),
    publicDir: resolveInside(root, config.publicDir ?? "public", "publicDir"),
    outDir: resolveInside(root, config.outDir ?? "dist", "outDir"),
    site: config.site,
    base,
    trailingSlash: config.trailingSlash ?? "ignore",
    output: config.output ?? "static",
    adapter: config.adapter,
    images: {
      formats: config.images?.formats ?? ["webp", "avif"],
      quality: imageQuality,
      strict: config.images?.strict ?? false,
    },
    cache: {
      dir: resolveInside(root, config.cache?.dir ?? ".elur/cache", "cache.dir"),
      defaultRevalidate: config.cache?.defaultRevalidate,
      adapter: config.cache?.adapter,
    },
    security: {
      allowedOrigins: config.security?.allowedOrigins ?? [],
      strictOrigin: config.security?.strictOrigin ?? false,
      bodyLimit: config.security?.bodyLimit ?? 1_048_576,
      headers: config.security?.headers === false
        ? false
        : config.security?.headers ?? {},
    },
    router: {
      enabled: config.router?.enabled ?? true,
      prefetch: config.router?.prefetch ?? true,
      morph: config.router?.morph ?? false,
      speculation: config.router?.speculation,
      loadingIndicator: config.router?.loadingIndicator ?? false,
    },
    js: config.js ?? "modern",
    // No forced level: the StructuredLogger defaults to "info" in production
    // and "debug" in development when `level` is undefined.
    logger: {
      level: config.logger?.level,
    },
    redirects: config.redirects ?? [],
    rewrites: config.rewrites ?? [],
    streaming: config.streaming ?? false,
    headers: config.headers ?? [],
    integrations: config.integrations ?? [],
    configFile,
  };
}

function mergeConfig(base: ElurConfig, override: ElurConfig): ElurConfig {
  return {
    ...base,
    ...override,
    images: { ...base.images, ...override.images },
    cache: { ...base.cache, ...override.cache },
    security: { ...base.security, ...override.security },
    router: { ...base.router, ...override.router },
    logger: { ...base.logger, ...override.logger },
    // Rule arrays match first-match-wins, so override rules go first: they
    // win over base rules for the same path while base keeps the rest.
    redirects: [...(override.redirects ?? []), ...(base.redirects ?? [])],
    rewrites: [...(override.rewrites ?? []), ...(base.rewrites ?? [])],
    headers: [...(override.headers ?? []), ...(base.headers ?? [])],
    integrations: override.integrations ?? base.integrations,
  };
}

function resolveInside(root: string, path: string, name: string): string {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`[elur-kit] ${name} must stay inside root: ${resolved}`);
  }
  return resolved;
}

function normalizeBase(base: string): string {
  if (!base.startsWith("/")) throw new Error("[elur-kit] base must start with /");
  return base === "/" ? base : `${base.replace(/\/+$/, "")}/`;
}

const PREFERRED_CONFIG_FILES = ["elur.config.ts", "elur.config.js", "elur.config.mjs"];

async function findConfigFile(root: string): Promise<string | undefined> {
  for (const name of PREFERRED_CONFIG_FILES) {
    const path = resolve(root, name);
    try {
      await access(path);
      return path;
    } catch {
    }
  }
  return undefined;
}
