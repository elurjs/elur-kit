import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "vite";
import { scanRoutes } from "../router/route-scanner.js";
import type { Adapter } from "./index.js";
import { copyStatic, writeSsrEntry } from "./shared.js";
import { SERVERLESS_CAPABILITIES } from "../runtime/capabilities.js";

/**
 * Vercel adapter for elur-kit.
 *
 * Produces a `.vercel/output` directory compatible with the Vercel Build Output
 * API (v3). Static files are served from `dist/` and unmatched routes fall back
 * to the SSR function.
 */
export const vercelAdapter: Adapter = {
  name: "vercel",
  capabilities: SERVERLESS_CAPABILITIES,

  async build(options) {
    const root = resolve(options.root);
    const outDir = resolve(root, options.outDir);
    const vercelOut = resolve(root, ".vercel/output");
    const functionsDir = join(vercelOut, "functions", "__elur-js-kit.func");
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
    await rm(vercelOut, { recursive: true, force: true });
    await mkdir(vercelOut, { recursive: true });
    await mkdir(functionsDir, { recursive: true });
    await mkdir(generatedDir, { recursive: true });

    // Copy static files.
    await copyStatic(outDir, join(vercelOut, "static"));

    // Scan routes and generate a self-contained function entry.
    const appDir = resolve(root, options.appDir);
    const routes = await scanRoutes(appDir);

    const entryPath = resolve(generatedDir, "vercel-index.ts");
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
          fileName: () => "index.js",
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
    const generatedHandler = join(functionsDir, "vercel-index.js");
    const targetHandler = join(functionsDir, "index.js");
    try {
      await stat(generatedHandler);
      await rename(generatedHandler, targetHandler);
    } catch {
      // If the file is already named index.js, nothing to do.
    }

    // Write Vercel function config.
    await writeFile(
      join(functionsDir, ".vc-config.json"),
      JSON.stringify(
        {
          runtime: "nodejs20.x",
          handler: "index.js",
          launcherType: "Nodejs",
          shouldAddHelpers: true,
        },
        null,
        2,
      ),
      "utf8",
    );

    // Write Vercel root config.
    await writeFile(
      join(vercelOut, "config.json"),
      JSON.stringify(
        {
          version: 3,
          routes: [
            { handle: "filesystem" },
            { src: "/(.*)", "dest": "/__elur-js-kit" },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
  },
};
