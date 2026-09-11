import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve, relative } from "node:path";
import { existsSync, watch } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build, type BuildConfig } from "./build/build.js";
import { transformProjectFiles, transformedAppDir as transformedAppDirOf } from "./build/transform-source.js";
import { scanActions } from "./action/scan.js";
import { scanRoutes } from "./router/route-scanner.js";
import { incomingMessageToRequest, sendWebResponse } from "./runtime/node-http.js";
import { createRequestLogger, type LogLevel } from "./runtime/logger.js";
import { loadElurConfig, type ResolvedElurConfig } from "./config/index.js";
import { createAppManifest, writeAppManifest, writeRouteTypes } from "./manifest/index.js";
import { validateCapabilities } from "./runtime/capabilities.js";
import * as out from "./cli/output.js";
import { listenWithFallback, PORT_UNAVAILABLE_EXIT_CODE } from "./cli/ports.js";

// --- CLI ---
//
// Minimal command-line interface for Elur Kit. Supports:
//   elur-kit build   — run a production static build
//   elur-kit dev     — run a dev server that rebuilds on file changes
//   elur-kit preview — serve the static build in production mode
//   elur-kit start   — run an SSR server that renders pages on demand
//
// This is intentionally small: no generators, no config file parsing, just
// convention-based defaults overridable via CLI flags.

export interface CliOptions {
  command: "build" | "dev" | "preview" | "start" | "adapter" | "check" | "routes" | "doctor";
  adapterName?: "vercel" | "netlify" | "bun" | "node";
  root: string;
  appDir: string;
  islandsDir?: string;
  outDir: string;
  publicDir?: string;
  generatedEntry: string;
  clientEntry: string;
  port: number;
  host: string;
  lang: string;
  hydrateImport?: string;
  routerImport?: string;
  /**
   * Path to a Vite config used to build the client hydration bundle.
   * In dev mode it is rebuilt whenever source files change.
   */
  clientConfig?: string;
  /** Absolute path to the ISR cache directory. */
  cacheDir?: string;
  /** Default revalidate interval in seconds for ISR. */
  defaultRevalidate?: number;
  configFile?: string;
  resolvedConfig?: ResolvedElurConfig;
  /**
   * Verbosity override from `--verbose` ("debug") / `--quiet` ("error").
   * Overrides `logger.level` from the config file.
   */
  logLevel?: LogLevel;
  /**
   * Internal: whether the client bundle emits the router as its own chunk
   * (`router.js`). Computed by `doBuild` from the resolved config and the
   * client bundle inputs — `true` for the kit-generated default config and
   * for user configs that declare the generated router module as an input.
   */
  routerSeparate?: boolean;
  /** Internal: whether the last build found any islands. */
  hasIslands?: boolean;
  /**
   * Internal: public URL of the router chunk when the emitted bundle
   * actually contains it (`/_elur/router.js` exists in the output).
   * Computed once per server start for dev/preview/start.
   */
  routerEntry?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-?")) {
    printHelp();
    process.exit(0);
  }
  const command = args[0];
  if (
    command !== "build" &&
    command !== "dev" &&
    command !== "preview" &&
    command !== "start" &&
    command !== "adapter" &&
    command !== "check" &&
    command !== "routes" &&
    command !== "doctor"
  ) {
    throw new Error(`Usage: elur-kit <build|dev|preview|start|adapter|check|routes|doctor> [options]`);
  }
  const adapterName = command === "adapter" ? args[1] : undefined;
  if (
    command === "adapter" &&
    adapterName !== "vercel" &&
    adapterName !== "netlify" &&
    adapterName !== "bun" &&
    adapterName !== "node"
  ) {
    throw new Error(`Usage: elur-kit adapter <vercel|netlify|bun|node> [options]`);
  }
  const optionStart = command === "adapter" ? 2 : 1;

  let root = process.cwd();
  let appDir = "src/app";
  let islandsDir = "src/islands";
  let outDir = "dist";
  let publicDir = "public";
  let generatedEntry = ".elur/entry-client.ts";
  let clientEntry = "/_elur/entry-client.js";
  let port = 3000;
  let host = "127.0.0.1";
  let lang = "es";
  let hydrateImport: string | undefined;
  let routerImport: string | undefined;
  let clientConfig: string | undefined;
  let cacheDir: string | undefined;
  let defaultRevalidate: number | undefined;
  let configFile: string | undefined;
  let logLevel: LogLevel | undefined;

  for (let i = optionStart; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--root":
      case "-r":
        root = next;
        i++;
        break;
      case "--app":
      case "-a":
        appDir = next;
        i++;
        break;
      case "--islands":
      case "-i":
        islandsDir = next;
        i++;
        break;
      case "--out":
      case "-o":
        outDir = next;
        i++;
        break;
      case "--public":
        publicDir = next;
        i++;
        break;
      case "--port":
      case "-p":
        port = Number(next);
        i++;
        break;
      case "--host":
      case "-h":
        host = next;
        i++;
        break;
      case "--lang":
      case "-l":
        lang = next;
        i++;
        break;
      case "--hydrate-import":
        hydrateImport = next;
        i++;
        break;
      case "--router-import":
        routerImport = next;
        i++;
        break;
      case "--client-config":
        clientConfig = next;
        i++;
        break;
      case "--config":
        configFile = next;
        i++;
        break;
      case "--cache-dir":
        cacheDir = next;
        i++;
        break;
      case "--default-revalidate":
        defaultRevalidate = Number(next);
        i++;
        break;
      case "--verbose":
        // --quiet wins when both are passed.
        if (logLevel !== "error") logLevel = "debug";
        break;
      case "--quiet":
        logLevel = "error";
        break;
      case "--help":
      case "-?":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    command,
    adapterName: adapterName as CliOptions["adapterName"],
    root: resolve(root),
    appDir: resolve(root, appDir),
    islandsDir: resolve(root, islandsDir),
    outDir: resolve(root, outDir),
    publicDir: resolve(root, publicDir),
    generatedEntry: resolve(root, generatedEntry),
    clientEntry,
    port,
    host,
    lang,
    hydrateImport,
    routerImport,
    clientConfig: clientConfig ? resolve(root, clientConfig) : undefined,
    cacheDir: cacheDir ? resolve(root, cacheDir) : undefined,
    defaultRevalidate,
    configFile: configFile ? resolve(root, configFile) : undefined,
    logLevel,
  };
}

function printHelp(): void {
  console.log(`
elur-kit <command> [options]

Commands:
  build            Run a static site build
  dev              Run a development server with rebuild-on-change
  preview          Serve the static build in production mode
  start            Run an SSR server that renders pages on demand
  adapter <name>   Generate deployment output for a platform (vercel|netlify|bun|node)
  check            Typecheck the project and validate route/config integrity
  routes           List all discovered routes and their metadata
  doctor           Diagnose common configuration and environment issues

Options:
  -r, --root <dir>          Project root (default: cwd)
  -a, --app <dir>           App directory relative to root (default: src/app)
  -i, --islands <dir>       Islands directory relative to root (default: src/islands)
  -o, --out <dir>           Output directory relative to root (default: dist)
  --public <dir>            Public directory relative to root (default: public)
  -p, --port <number>       Server port (default: 3000)
  -h, --host <address>      Server host (default: 127.0.0.1)
  -l, --lang <lang>         HTML lang attribute (default: es)
  --hydrate-import <spec>   Import specifier for hydrateIslands in generated entry
  --router-import <spec>    Import specifier for startClientRouter in generated entry
  --client-config <path>    Vite config used to build the client hydration bundle
  --config <path>           Elur config file (default: elur.config.ts/js/mjs)
  --cache-dir <dir>         Directory for ISR cache (only used by start)
  --default-revalidate <s>  Default ISR revalidate interval in seconds
  --verbose                 Debug logging (overrides logger.level)
  --quiet                   Only errors are printed (overrides logger.level)
`);
}

/**
 * Reads the kit's own version from package.json. The CLI runs from two
 * layouts: src/cli.ts in the repo (../package.json) and dist/lib/cli.js when
 * installed (../../package.json).
 */
function getKitVersion(): string {
  const require = createRequire(import.meta.url);
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkg = require(rel) as { version?: unknown };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      // Try the next layout.
    }
  }
  return "unknown";
}

function toBuildConfig(options: CliOptions): BuildConfig {
  return {
    root: options.root,
    appDir: options.appDir,
    outDir: options.outDir,
    publicDir: options.publicDir,
    clientEntry: options.clientEntry,
    lang: options.lang,
    islandsDir: options.islandsDir,
    generatedEntry: options.generatedEntry,
    hydrateImport: options.hydrateImport,
    routerImport: options.routerImport,
    imageFormats: options.resolvedConfig?.images.formats,
    integrations: options.resolvedConfig?.integrations,
    site: options.resolvedConfig?.site,
    js: options.resolvedConfig?.js,
    router: options.resolvedConfig
      ? {
        enabled: options.resolvedConfig.router.enabled,
        prefetch: options.resolvedConfig.router.prefetch,
        morph: options.resolvedConfig.router.morph,
        loadingIndicator: options.resolvedConfig.router.loadingIndicator,
        speculation: options.resolvedConfig.router.speculation,
        // Whether the bundle emits the router as its own chunk — computed
        // before pages render so the shell knows to advertise router.js.
        separate: options.routerSeparate,
        entry: "/_elur/router.js",
        outFile: join(dirname(options.generatedEntry), "router.ts"),
      }
      : undefined,
  };
}

async function doBuild(options: CliOptions): Promise<void> {
  const buildStart = Date.now();
  const transformedRoot = join(options.root, ".elur", "transformed");
  const transformedAppDir = transformedAppDirOf(options.root, options.appDir, options.islandsDir, transformedRoot);
  let phaseStart = performance.now();
  await transformProjectFiles({
    root: options.root,
    appDir: options.appDir,
    islandsDir: options.islandsDir,
    outDir: transformedRoot,
  });
  out.phase("transform", performance.now() - phaseStart);

  // Atomic output staging: build into a temp directory, then swap to the final
  // outDir so a crashed build never leaves a half-written dist.
  const { beginAtomicStage } = await import("./build/vite-build.js");
  const stage = await beginAtomicStage({ outDir: options.outDir });
  const tempOutDir = stage.tempDir;

  // Resolve the client bundle layout BEFORE rendering pages: whether the
  // router is emitted as its own chunk decides both the generated entry
  // (hydrate-only vs combined) and which scripts the shell advertises.
  if (options.islandsDir && !options.clientConfig) {
    const autoConfig = await findClientConfig(options.root);
    if (autoConfig) options.clientConfig = autoConfig;
  }
  options.routerSeparate = await resolveRouterSeparate(options);

  try {
    const buildConfig = toBuildConfig(options);
    buildConfig.appDir = transformedAppDir;
    buildConfig.outDir = tempOutDir;
    buildConfig.onPhase = (name, ms) => out.phase(name, ms);
    const result = await build(buildConfig);
    options.hasIslands = result.islands.length > 0;

    // Emit the portable application manifest and route types when a resolved
    // config is available. The manifest is the source of truth for adapters,
    // the client island registry and runtime route metadata.
    if (options.resolvedConfig) {
      phaseStart = performance.now();
      try {
        const manifest = await createAppManifest(options.resolvedConfig);
        const manifestPath = join(tempOutDir, ".elur", "manifest.json");
        await writeAppManifest(manifest, manifestPath);
        const typesPath = join(options.root, ".elur", "routes.d.ts");
        await writeRouteTypes(manifest, typesPath);
        out.phase("manifest", performance.now() - phaseStart);
      } catch (err) {
        out.warn(`manifest generation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Build the client bundle when there is something to ship: islands to
    // hydrate, a router to run, or an explicit user config (which may bundle
    // extra client code beyond the generated entry). Without a user config,
    // the kit synthesizes a default one from the generated inputs.
    const routerEnabled = options.resolvedConfig?.router.enabled !== false;
    if (options.clientConfig || options.hasIslands || routerEnabled) {
      // Temporarily redirect the client build to the staging directory.
      const originalOutDir = options.outDir;
      options.outDir = tempOutDir;
      try {
        phaseStart = performance.now();
        await buildClient(options);
        out.phase("client bundle", performance.now() - phaseStart);
      } finally {
        options.outDir = originalOutDir;
      }
    }

    // Atomically swap the staged output into the final destination.
    await stage.commit();

    const elapsed = ((Date.now() - buildStart) / 1000).toFixed(2);
    out.success(`${out.bold("Build completo")} ${out.dim(`en ${elapsed}s`)}`);
    out.info(`${result.pages} página(s), ${result.islands.length} island(s), ${result.files.length} archivo(s)`);
    const fileEntries: out.FileEntry[] = [];
    for (const file of result.files) {
      // result.files point at the staging directory; display the final path.
      const finalPath = join(options.outDir, relative(tempOutDir, file));
      let bytes = 0;
      try {
        bytes = (await stat(finalPath)).size;
      } catch {
        // File may have been moved by an integration; size stays 0.
      }
      fileEntries.push({ path: relative(options.root, finalPath), bytes });
    }
    out.fileList(fileEntries);
    if (result.islands.length > 0) {
      out.success(`${result.islands.length} island(s) detectada(s):`);
      for (const island of result.islands) {
        out.detail(island.name);
      }
      if (result.generatedEntry) {
        out.detail(`entry: ${relative(options.root, result.generatedEntry)}`);
      }
    }
    if (result.skipped.length > 0) {
      out.warn("Rutas dinámicas omitidas (necesitan generateStaticParams):");
      for (const path of result.skipped) {
        out.detail(path);
      }
    }
  } catch (err) {
    await stage.rollback();
    throw err;
  }
}

const DEV_WORKER_ENV = "ELUR_JS_KIT_DEV_WORKER";

async function doDev(options: CliOptions): Promise<void> {
  await doBuild(options);

  const transformedRoot = join(options.root, ".elur", "transformed");
  const transformedAppDir = transformedAppDirOf(options.root, options.appDir, options.islandsDir, transformedRoot);
  await transformProjectFiles({
    root: options.root,
    appDir: options.appDir,
    islandsDir: options.islandsDir,
    outDir: transformedRoot,
  });

  const actions = await scanActions(transformedAppDir);
  const routes = await scanRoutes(transformedAppDir);
  const middleware = await loadUserMiddleware(options.root);
  options.routerEntry = detectRouterEntry(options);
  const server = createServer((req, res) => handleRequest(req, res, options, actions, routes, true, middleware));

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    const usedPort = await listenWithFallback(server, options.host, options.port, {
      onFallback: (busyPort, nextPort) => out.warn(`Puerto ${busyPort} ocupado, usando ${nextPort}`),
    });
    const network = out.getNetworkAddress();
    out.serverBanner({
      name: "elur-kit",
      version: `v${getKitVersion()}`,
      command: "dev",
      localUrl: `http://${options.host}:${usedPort}/`,
      networkUrl: network ? `http://${network}:${usedPort}/` : undefined,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      out.error(`No hay puerto disponible entre ${options.port} y ${options.port + 20}.`);
      // Distinct exit code so the supervisor does not restart-loop.
      process.exit(PORT_UNAVAILABLE_EXIT_CODE);
    }
    throw err;
  }
}

/**
 * Dev supervisor: runs the actual dev server in a child process and restarts
 * it whenever app/islands source files change. A fresh process means a fresh
 * module registry, so edits to pages, loaders, layouts and islands are always
 * picked up (no stale ESM cache).
 */
async function doDevSupervisor(options: CliOptions): Promise<void> {
  // Re-invoke this bin with the same flags; the worker branch (env var set)
  // runs the actual server in a fresh process.
  const binPath = process.argv[1];
  const spawnPath = binPath && existsSync(binPath)
    ? binPath
    : fileURLToPath(import.meta.url);
  const args = process.argv.slice(2);

  let child: import("node:child_process").ChildProcess | null = null;
  let stopping = false;
  let intentional = false;
  let respawnTimer: ReturnType<typeof setTimeout> | null = null;

  const startWorker = () => {
    intentional = false;
    console.log();
    out.event("dev", "Starting dev server...");
    child = spawn(process.execPath, [spawnPath, ...args], {
      env: { ...process.env, [DEV_WORKER_ENV]: "1" },
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      child = null;
      if (stopping) return;
      if (intentional) {
        // Restart after a source change.
        respawnTimer = setTimeout(startWorker, 400);
        return;
      }
      if (code !== 0) {
        if (code === PORT_UNAVAILABLE_EXIT_CODE) {
          // The worker already reported that no port is available; restarting
          // would loop forever on the same EADDRINUSE.
          out.error("[dev] Stopping: no available port.");
          process.exit(code);
        }
        out.error(`[dev] Dev server exited with code ${code}; restarting...`);
        respawnTimer = setTimeout(startWorker, 600);
      }
    });
  };

  const restart = () => {
    if (!child) return;
    intentional = true;
    child.kill("SIGTERM");
  };

  const watchedDirs = [options.appDir, options.islandsDir].filter(Boolean) as string[];
  if (watchedDirs.length > 0) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRestart = () => {
      console.log();
      out.event("change", "Restarting dev server...");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => restart(), 150);
    };
    for (const dir of watchedDirs) {
      try {
        watch(dir, { recursive: true }, (event, filename) => {
          // Editors and sed replace files via atomic rename, which reports the
          // temporary name (e.g. "blog/sed1234") instead of the .ts file, so
          // treat every rename as a potential source change. "change" events
          // only restart when the reported name looks like a source file.
          if (event === "rename") {
            scheduleRestart();
          } else if (filename && /\.ts$/.test(filename)) {
            scheduleRestart();
          }
        });
      } catch (err) {
        out.error(`[dev] failed to watch ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const cleanup = () => {
    stopping = true;
    if (respawnTimer) clearTimeout(respawnTimer);
    if (child) child.kill("SIGTERM");
    // Exit after the worker has gone, so a new supervisor can take over the port.
    const deadline = setTimeout(() => process.exit(0), 3000);
    deadline.unref();
    if (!child) process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  startWorker();
}

/**
 * Shared production-serving path for `preview` and `start`: serves the build
 * output plus dynamic SSR through the unified Web handler, with middleware,
 * streaming, port fallback and the startup banner. Both commands behave
 * identically; the label only differs in the banner.
 */
async function startProductionServer(
  options: CliOptions,
  command: "preview" | "start",
): Promise<import("node:http").Server> {
  try {
    const s = await stat(options.outDir);
    if (!s.isDirectory()) {
      throw new Error(`Output path is not a directory: ${options.outDir}`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `No build output found at ${options.outDir}. Run \`elur-kit build\` first.`,
      );
    }
    throw err;
  }

  const transformedRoot = join(options.root, ".elur", command === "preview" ? "preview-transformed" : "transformed");
  const transformedAppDir = transformedAppDirOf(options.root, options.appDir, options.islandsDir, transformedRoot);
  await transformProjectFiles({
    root: options.root,
    appDir: options.appDir,
    islandsDir: options.islandsDir,
    outDir: transformedRoot,
  });

  const actions = await scanActions(transformedAppDir);
  const routes = await scanRoutes(transformedAppDir);
  const middleware = await loadUserMiddleware(options.root);
  options.routerEntry = detectRouterEntry(options);
  const server = createServer((req, res) => handleRequest(req, res, options, actions, routes, false, middleware));
  const usedPort = await listenWithFallback(server, options.host, options.port, {
    onFallback: (busyPort, nextPort) => out.warn(`Puerto ${busyPort} ocupado, usando ${nextPort}`),
  });
  const network = out.getNetworkAddress();
  out.serverBanner({
    name: "elur-kit",
    version: `v${getKitVersion()}`,
    command,
    localUrl: `http://${options.host}:${usedPort}/`,
    networkUrl: network ? `http://${network}:${usedPort}/` : undefined,
  });
  return server;
}

export async function doPreview(options: CliOptions): Promise<import("node:http").Server> {
  return startProductionServer(options, "preview");
}

async function doStart(options: CliOptions): Promise<void> {
  // `start` now runs on the unified Web handler like dev/preview (it used to
  // rely on the legacy createSsrServer pipeline).
  await startProductionServer(options, "start");
}

async function findClientConfig(root: string): Promise<string | undefined> {
  const candidates = ["vite.client.config.ts", "vite.client.config.js", "vite.client.config.mjs"];
  for (const name of candidates) {
    const path = resolve(root, name);
    try {
      if ((await stat(path)).isFile()) return path;
    } catch {
      // ignore
    }
  }
  return undefined;
}

/**
 * Decides whether the client bundle emits the router as its own chunk.
 *
 * - `js: "legacy"` or `router.enabled: false` → never split (the entry is
 *   hydrate-only when the router is off; legacy embeds the router).
 * - A user-provided client config splits only when it declares the generated
 *   router module (`.elur/router.ts`) as a bundle input — a single input is
 *   "legacy de facto": the router stays embedded in `entry-client.js`.
 * - Without a user config, the kit synthesizes a default two-input config →
 *   split.
 */
async function resolveRouterSeparate(options: CliOptions): Promise<boolean> {
  const rc = options.resolvedConfig;
  if (!rc || rc.js === "legacy" || rc.router.enabled === false) return false;
  const routerFile = join(dirname(options.generatedEntry), "router.ts");
  if (!options.clientConfig) return true;
  try {
    const { resolveClientInputs } = await import("./build/vite-build.js");
    const inputs = await resolveClientInputs(options.clientConfig, options.root);
    return inputs.includes(routerFile);
  } catch {
    return false;
  }
}

/**
 * Public URL of the router chunk when the built bundle actually contains it.
 * The file check keeps `preview`/`start` consistent with whatever layout the
 * last build produced (split or legacy single-entry).
 */
function detectRouterEntry(options: CliOptions): string | undefined {
  const rc = options.resolvedConfig;
  if (!rc || rc.js === "legacy" || rc.router.enabled === false) return undefined;
  return existsSync(join(options.outDir, "_elur", "router.js"))
    ? "/_elur/router.js"
    : undefined;
}

async function buildClient(options: CliOptions): Promise<void> {
  // Use the programmatic Vite build API instead of spawnSync("npx", ["vite", ...]).
  // This avoids child-process overhead, shares the module cache, and gives us
  // structured errors instead of exit-code parsing.
  const { buildClientBundle } = await import("./build/vite-build.js");
  const clientOutDir = join(options.outDir, "_elur");
  // The client bundle is always served from /_elur/ regardless of the
  // project's deployment base. The deployment base is applied to page HTML,
  // not to the internal hydration bundle path.
  const clientBase = "/_elur/";
  // Inputs for the kit-synthesized default config (used only when the
  // project does not ship its own vite.client.config.*).
  const defaultInputs: Record<string, string> = {
    "entry-client": options.generatedEntry,
  };
  if (options.routerSeparate) {
    defaultInputs.router = join(dirname(options.generatedEntry), "router.ts");
  }
  await buildClientBundle({
    root: options.root,
    userConfigPath: options.clientConfig ? resolve(options.clientConfig) : undefined,
    defaultInputs,
    appDir: join(options.root, "src", "app"),
    islandsDir: join(options.root, "src", "islands"),
    outDir: clientOutDir,
    base: clientBase,
    logPrefix: "[client]",
    quiet: options.logLevel === "error",
  });
}

/**
 * Loads the project's `src/middleware.ts` for dev/preview/start. A missing
 * file is fine; a broken one warns but does not stop the server.
 */
async function loadUserMiddleware(
  root: string,
): Promise<import("./middleware/index.js").LoadedMiddleware | null> {
  const { loadMiddleware } = await import("./middleware/index.js");
  try {
    return await loadMiddleware(root);
  } catch (err) {
    out.warn(err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function handleRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  options: CliOptions,
  actions: import("./action/scan.js").ActionRegistry,
  routes: import("./router/route-scanner.js").ScannedRoutes,
  noCache = false,
  middleware?: import("./middleware/index.js").LoadedMiddleware | null,
): Promise<void> {
  // Unified pipeline: actions, render endpoint, API routes, static files and
  // dynamic SSR all run through `createWebHandler`, the same code used by the
  // Node/Bun/Vercel/Netlify adapters. This eliminates the duplicated request
  // handling that previously diverged between dev/preview/start and adapters
  // (audit §8.1, Risk 1).
  const { createWebHandler } = await import("./runtime/handler.js");
  const securityHeaders = (options.resolvedConfig as { security?: { headers?: unknown } } | undefined)?.security?.headers;
  const webHandler = createWebHandler(
    routes,
    actions,
    {
      staticRoot: options.outDir,
      noCache,
      cacheDir: options.cacheDir,
      defaultRevalidate: options.defaultRevalidate,
      lang: options.lang,
      clientEntry: options.clientEntry,
      renderEndpoint: true,
      router: {
        enabled: options.resolvedConfig?.router.enabled ?? true,
        entry: options.routerEntry,
      },
      js: options.resolvedConfig?.js,
      securityHeaders: securityHeaders === undefined ? false : (securityHeaders as never),
      logLevel: options.resolvedConfig?.logger?.level,
      cacheAdapter: options.resolvedConfig?.cache?.adapter,
      redirects: options.resolvedConfig?.redirects,
      rewrites: options.resolvedConfig?.rewrites,
      routeHeaders: options.resolvedConfig?.headers,
      streaming: options.resolvedConfig?.streaming,
      middleware: middleware ?? undefined,
    },
  );

  const body = req.method && req.method !== "GET" && req.method !== "HEAD"
    ? await readRequestBody(req)
    : undefined;
  const request = incomingMessageToRequest(req, body);
  let response: Response;
  try {
    response = await webHandler(request);
  } catch (err) {
    // Last-resort failure outside the unified handler: log through the
    // structured logger at server level (a fresh per-request logger, since
    // the handler's own logger is unreachable here).
    createRequestLogger(request, options.resolvedConfig?.logger?.level).error("[elur-kit] request error", {
      path: new URL(request.url).pathname,
      method: request.method,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
    return;
  }
  // Stream the response body to the socket: for streaming SSR responses the
  // chunks are flushed as they are produced instead of being buffered whole.
  await sendWebResponse(res, response);
}

function readRequestBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function doAdapter(options: CliOptions): Promise<void> {
  const adapterOptions = {
    root: options.root,
    appDir: options.appDir,
    islandsDir: options.islandsDir ?? resolve(options.root, "src/islands"),
    outDir: options.outDir,
    publicDir: options.publicDir,
    clientEntry: options.clientEntry,
    lang: options.lang,
    hydrateImport: options.hydrateImport,
    logLevel: options.resolvedConfig?.logger?.level,
    cacheAdapter: options.resolvedConfig?.cache?.adapter,
    redirects: options.resolvedConfig?.redirects,
    rewrites: options.resolvedConfig?.rewrites,
    routeHeaders: options.resolvedConfig?.headers,
    streaming: options.resolvedConfig?.streaming,
    router: { enabled: options.resolvedConfig?.router.enabled ?? true },
    js: options.resolvedConfig?.js,
  };
  const resolvedConfig = options.resolvedConfig as { images?: { strict?: boolean }; cache?: { defaultRevalidate?: number }; streaming?: boolean } | undefined;
  const features = {
    isr: typeof resolvedConfig?.cache?.defaultRevalidate === "number" && resolvedConfig.cache.defaultRevalidate > 0,
    images: resolvedConfig?.images?.strict === true,
    streaming: resolvedConfig?.streaming === true,
  };
  let adapterName = options.adapterName;
  if (adapterName === "vercel") {
    const { vercelAdapter } = await import("./adapters/vercel.js");
    assertCapabilities(vercelAdapter, features, adapterName);
    await vercelAdapter.build(adapterOptions);
    console.log();
    out.info("Vercel output generated at .vercel/output");
  } else if (adapterName === "netlify") {
    const { netlifyAdapter } = await import("./adapters/netlify.js");
    assertCapabilities(netlifyAdapter, features, adapterName);
    await netlifyAdapter.build(adapterOptions);
    console.log();
    out.info("Netlify output generated at netlify/functions/__elur-js-kit.mjs");
  } else if (adapterName === "bun") {
    const { bunAdapter } = await import("./adapters/bun.js");
    assertCapabilities(bunAdapter, features, adapterName);
    await bunAdapter.build(adapterOptions);
    console.log();
    out.info("Bun server generated at .elur/bun-server.ts");
  } else if (adapterName === "node") {
    const { nodeAdapter } = await import("./adapters/node.js");
    assertCapabilities(nodeAdapter, features, adapterName);
    await nodeAdapter.build(adapterOptions);
    console.log();
    out.info("Node server generated at .elur/node-server.mjs");
  }
}

function assertCapabilities(
  adapter: { capabilities?: import("./runtime/capabilities.js").AdapterCapabilities },
  features: { isr: boolean; images: boolean; streaming?: boolean },
  adapterName: string,
): void {
  if (!adapter.capabilities) return;
  const diagnostics = validateCapabilities(adapter.capabilities, features);
  if (!diagnostics.ok) {
    throw new Error(
      `[elur-kit] Adapter "${adapterName}" cannot satisfy the requested features:\n  - ${diagnostics.problems.join("\n  - ")}`,
    );
  }
}

async function applyProjectConfig(options: CliOptions, argv: string[]): Promise<void> {
  // Map non-build commands to "build" or "serve" for config resolution.
  const command = (options.command === "adapter" || options.command === "routes" || options.command === "doctor")
    ? "build"
    : options.command;
  const config = await loadElurConfig({
    root: options.root,
    configFile: options.configFile,
    command,
  });
  const args = argv.slice(2);
  const has = (...names: string[]) => names.some((name) => args.includes(name));
  options.root = config.root;
  if (!has("--app", "-a")) options.appDir = config.appDir;
  if (!has("--islands", "-i")) options.islandsDir = config.islandsDir;
  if (!has("--out", "-o")) options.outDir = config.outDir;
  if (!has("--public")) options.publicDir = config.publicDir;
  if (!has("--cache-dir")) options.cacheDir = config.cache.dir;
  if (!has("--default-revalidate")) options.defaultRevalidate = config.cache.defaultRevalidate;
  // --verbose/--quiet override logger.level from the config file.
  if (options.logLevel) config.logger.level = options.logLevel;
  options.generatedEntry = resolve(config.root, ".elur/entry-client.ts");
  options.resolvedConfig = config;
}

export async function run(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  if (options.logLevel === "error") out.setQuiet(true);

  // Commands that don't need project config resolution.
  if (options.command === "doctor") {
    const { doDoctor } = await import("./cli/commands.js");
    const code = await doDoctor(options);
    process.exit(code);
  }

  await applyProjectConfig(options, argv);

  if (options.command === "build") {
    await doBuild(options);
  } else if (options.command === "preview") {
    await doPreview(options);
  } else if (options.command === "start") {
    await doStart(options);
  } else if (options.command === "adapter") {
    await doAdapter(options);
  } else if (options.command === "check") {
    const { doCheck } = await import("./cli/commands.js");
    const code = await doCheck(options);
    process.exit(code);
  } else if (options.command === "routes") {
    const { doRoutes } = await import("./cli/commands.js");
    const code = await doRoutes(options);
    process.exit(code);
  } else if (process.env[DEV_WORKER_ENV] === "1") {
    await doDev(options);
  } else {
    await doDevSupervisor(options);
  }
}
