/**
 * Common options shared by all elur-kit deployment adapters.
 */
export interface AdapterOptions {
  /** Project root directory. */
  root: string;
  /** Pages directory relative to root (default: src/app). */
  appDir: string;
  /** Islands directory relative to root (default: src/islands). */
  islandsDir: string;
  /** Output directory relative to root (default: dist). */
  outDir: string;
  /** Public directory relative to root (default: public). */
  publicDir?: string;
  /** Public path for the client entry module (default: /_elur/entry-client.js). */
  clientEntry: string;
  /** HTML lang attribute (default: es). */
  lang: string;
  /** Import specifier for hydrateIslands in the generated client entry. */
  hydrateImport?: string;
  /** Minimum log level for the runtime structured logger. */
  logLevel?: import("../runtime/logger.js").LogLevel;
  /**
   * Pluggable ISR cache adapter (programmatic only). Note: the generated
   * Node/Bun servers cannot serialize adapter instances — they only serve
   * static files and delegate SSR to the bundled handler.
   */
  cacheAdapter?: import("../cache/adapter.js").CacheAdapter;
  /** Redirect rules evaluated before any routing. */
  redirects?: import("../router/redirects.js").RedirectRule[];
  /** Rewrite rules applied transparently before routing. */
  rewrites?: import("../router/redirects.js").RewriteRule[];
  /** Extra response headers applied to matching request paths. */
  routeHeaders?: import("../router/redirects.js").RouteHeadersRule[];
  /**
   * Opt-in streaming SSR (experimental). Baked into the generated server:
   * routes with a `loading` boundary stream shell-first when the adapter
   * declares `capabilities.streaming: true`.
   */
  streaming?: boolean;
  /**
   * Client router flag baked into the generated server. When `enabled` is
   * false the SSR output emits no client scripts and no render-endpoint
   * marker; when a split `/_elur/router.js` chunk exists in the build output
   * it is advertised as the router entry automatically.
   */
  router?: { enabled?: boolean };
  /**
   * Client JS mode baked into the generated server. `"legacy"` restores the
   * unconditional single client entry (pre-0%-JS behavior).
   */
  js?: "modern" | "legacy";
}

/**
 * An adapter turns a elur-kit build into a deployment target output.
 */
export interface Adapter {
  name: string;
  build(options: AdapterOptions): Promise<void>;
  /** Declared host capabilities used for build-time diagnostics (§8.5). */
  capabilities?: import("../runtime/capabilities.js").AdapterCapabilities;
}
