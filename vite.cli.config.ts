import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";

// ── CLI build configuration ─────────────────────────────────────────────────
//
//   npm run build:cli
//
// Produces a single self-contained CommonJS-compatible bundle for the CLI.
// It is kept separate from the library build so Node built-ins are not mixed
// with code-split library chunks that get mangled by terser.

// The image registry holds build-time state (renderRegistry / activeManifest)
// that MUST be shared with the library chunk `dist/lib/image/registry.js`.
// If the CLI inlines its own copy, `consumeImageRegistry()` reads a different
// (empty) array than the one the app's `image()` calls populated, and the
// two-pass build silently processes nothing. This plugin intercepts the
// resolution of `src/image/registry.ts` and marks it external with a fixed
// runtime id (`./image/registry.js`) so the CLI imports the physical chunk
// that lives next to it in `dist/lib/`.
const REGISTRY_SOURCE = resolve("src/image/registry.ts");
function externalizeImageRegistry(): Plugin {
    return {
        name: "externalize-image-registry",
        enforce: "pre",
        resolveId(source, importer) {
            if (!importer) return null;
            // Match the relative import from src/image/index.ts (`./registry.js`)
            // and any resolved form of the registry module.
            if (source === "./registry.js" && importer.includes("image/index")) {
                return { id: "./image/registry.js", external: true };
            }
            if (resolve(source) === REGISTRY_SOURCE) {
                return { id: "./image/registry.js", external: true };
            }
            return null;
        },
    };
}

export default defineConfig({
    publicDir: false,

    build: {
        outDir: "dist/lib",
        emptyOutDir: false,
        sourcemap: true,
        minify: false,
        ssr: true,

        lib: {
            entry: resolve("src/cli.ts"),
            name: "NixJSKitCli",
            formats: ["es", "cjs"],
            fileName: (format) => format === "cjs" ? "cli.cjs" : "cli.js",
        },

        rollupOptions: {
            external: /^@deijose\/nix-js(?:\/.*)?$/,
            output: {
                codeSplitting: false,
            },
        },
    },

    plugins: [externalizeImageRegistry()],
});
