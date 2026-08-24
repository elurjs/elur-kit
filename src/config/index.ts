import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { loadConfigFromFile } from "vite";
import type { Adapter } from "../adapters/index.js";
import type { ImageFormat } from "../image/index.js";
import type { NixKitIntegration } from "../integrations/index.js";
import { runIntegrationHook } from "../integrations/index.js";

export type NixOutputMode = "static" | "server" | "hybrid";
export type TrailingSlashMode = "always" | "never" | "ignore";

export interface NixConfig {
  root?: string;
  appDir?: string;
  islandsDir?: string;
  contentDir?: string;
  publicDir?: string;
  outDir?: string;
  site?: string;
  base?: string;
  trailingSlash?: TrailingSlashMode;
  output?: NixOutputMode;
  adapter?: Adapter;
  images?: {
    formats?: ImageFormat[];
    quality?: number;
    strict?: boolean;
  };
  cache?: {
    dir?: string;
    defaultRevalidate?: number;
  };
  security?: {
    allowedOrigins?: string[];
    strictOrigin?: boolean;
    bodyLimit?: number;
    /** Security response headers. Set to `false` to disable defaults. */
    headers?: SecurityHeadersConfig | false;
  };
  router?: {
    enabled?: boolean;
    prefetch?: boolean;
  };
  integrations?: NixKitIntegration[];
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

export interface ResolvedNixConfig {
  root: string;
  appDir: string;
  islandsDir: string;
  contentDir: string;
  publicDir: string;
  outDir: string;
  site?: string;
  base: string;
  trailingSlash: TrailingSlashMode;
  output: NixOutputMode;
  adapter?: Adapter;
  images: {
    formats: ImageFormat[];
    quality: number;
    strict: boolean;
  };
  cache: {
    dir: string;
    defaultRevalidate?: number;
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
  };
  integrations: NixKitIntegration[];
  configFile?: string;
}

export interface LoadNixConfigOptions {
  root?: string;
  configFile?: string;
  command?: "dev" | "build" | "preview" | "start" | "check" | "routes" | "doctor";
  mode?: string;
  overrides?: NixConfig;
}

export function defineConfig(config: NixConfig): NixConfig {
  return config;
}

export async function loadNixConfig(options: LoadNixConfigOptions = {}): Promise<ResolvedNixConfig> {
  const initialRoot = resolve(options.root ?? process.cwd());
  const configFile = options.configFile
    ? resolve(initialRoot, options.configFile)
    : await findConfigFile(initialRoot);
  let loaded: NixConfig = {};

  if (configFile) {
    const result = await loadConfigFromFile(
      { command: options.command === "build" ? "build" : "serve", mode: options.mode ?? "development" },
      configFile,
      initialRoot,
    );
    if (!result) throw new Error(`[nix-js-kit] Could not load config: ${configFile}`);
    loaded = result.config as NixConfig;
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

function resolveConfig(root: string, config: NixConfig, configFile?: string): ResolvedNixConfig {
  if (config.site) new URL(config.site);
  const base = normalizeBase(config.base ?? "/");
  const imageQuality = config.images?.quality ?? 80;
  if (!Number.isFinite(imageQuality) || imageQuality < 1 || imageQuality > 100) {
    throw new Error("[nix-js-kit] images.quality must be between 1 and 100");
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
      dir: resolveInside(root, config.cache?.dir ?? ".nix-js/cache", "cache.dir"),
      defaultRevalidate: config.cache?.defaultRevalidate,
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
    },
    integrations: config.integrations ?? [],
    configFile,
  };
}

function mergeConfig(base: NixConfig, override: NixConfig): NixConfig {
  return {
    ...base,
    ...override,
    images: { ...base.images, ...override.images },
    cache: { ...base.cache, ...override.cache },
    security: { ...base.security, ...override.security },
    router: { ...base.router, ...override.router },
    integrations: override.integrations ?? base.integrations,
  };
}

function resolveInside(root: string, path: string, name: string): string {
  const resolved = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`[nix-js-kit] ${name} must stay inside root: ${resolved}`);
  }
  return resolved;
}

function normalizeBase(base: string): string {
  if (!base.startsWith("/")) throw new Error("[nix-js-kit] base must start with /");
  return base === "/" ? base : `${base.replace(/\/+$/, "")}/`;
}

const PREFERRED_CONFIG_FILES = ["nix-js.config.ts", "nix-js.config.js", "nix-js.config.mjs"];
// Legacy names kept for backward compatibility. Emit a deprecation warning
// when a project still uses them so authors migrate to `nix-js.config.*`.
const LEGACY_CONFIG_FILES = ["nix.config.ts", "nix.config.js", "nix.config.mjs"];

async function findConfigFile(root: string): Promise<string | undefined> {
  for (const name of PREFERRED_CONFIG_FILES) {
    const path = resolve(root, name);
    try {
      await access(path);
      return path;
    } catch {
    }
  }
  for (const name of LEGACY_CONFIG_FILES) {
    const path = resolve(root, name);
    try {
      await access(path);
      console.warn(
        `[nix-js-kit] "${name}" is deprecated and will be removed in a future release. ` +
        `Rename it to "nix-js.config.${name.split(".").slice(1).join(".")}" to keep your config working.`,
      );
      return path;
    } catch {
    }
  }
  return undefined;
}
