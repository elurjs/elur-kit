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
