import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "vite";
import { scanRoutes } from "../router/route-scanner.js";
import type { Adapter } from "./index.js";
import { writeSsrEntry } from "./shared.js";
import { SERVERLESS_CAPABILITIES } from "../runtime/capabilities.js";

/**
 * Netlify adapter for elur-kit.
 *
 * Produces the files expected by Netlify Functions v2:
 *   - `netlify/functions/__elur-js-kit.mjs` — bundled SSR function.
 *   - `netlify.toml` — redirects unmatched routes to the function.
 *
 * Run this after `elur-kit build`. The static files are left in `dist/` and
 * served directly by Netlify; the function only handles routes that have no
 * matching static file.
 */
export const netlifyAdapter: Adapter = {
  name: "netlify",
  capabilities: SERVERLESS_CAPABILITIES,

  async build(options) {
    const root = resolve(options.root);
    const outDir = resolve(root, options.outDir);
    const netlifyDir = resolve(root, "netlify");
    const functionsDir = join(netlifyDir, "functions");
    const generatedDir = resolve(root, ".elur");

    // Verify the production build exists.
    try {
      await stat(outDir);
    } catch {
      throw new Error(
        `Output directory not found: ${outDir}. Run "elur-kit build" first.`,
      );
    }

    // Clean previous adapter output.
    await rm(functionsDir, { recursive: true, force: true });
    await mkdir(functionsDir, { recursive: true });
    await mkdir(generatedDir, { recursive: true });

    // Scan routes and generate a self-contained function entry.
    const appDir = resolve(root, options.appDir);
    const routes = await scanRoutes(appDir);

    const entryPath = resolve(generatedDir, "netlify-index.ts");
    await writeSsrEntry(entryPath, routes, options);

    // Bundle the function entry.
    await build({
      configFile: false,
      root,
      build: {
        outDir: functionsDir,
        emptyOutDir: true,
        ssr: true,
        lib: {
          entry: entryPath,
          formats: ["es"],
          fileName: () => "__elur-js-kit.mjs",
        },
        rollupOptions: {
          external: [],
          output: {
            inlineDynamicImports: true,
          },
        },
      },
    });

    // Vite SSR lib builds may use the entry file name, so force the expected handler name.
    const generatedHandler = join(functionsDir, "netlify-index.js");
    const targetHandler = join(functionsDir, "__elur-js-kit.mjs");
    try {
      await stat(generatedHandler);
      await rename(generatedHandler, targetHandler);
    } catch {
      // If the file is already named __elur-js-kit.mjs, nothing to do.
    }

    // Write Netlify redirects config.
    await writeFile(
      join(root, "netlify.toml"),
      `[build]
  command = "elur-kit build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/.netlify/functions/__elur-js-kit"
  status = 200
`,
      "utf8",
    );
  },
};
