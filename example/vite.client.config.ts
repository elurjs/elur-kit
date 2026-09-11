import { defineConfig } from "vite";
import { resolve } from "path";

// Two inputs → two chunks:
//   entry-client.js — hydrate-only islands entry (emitted per page when the
//     rendered HTML contains islands).
//   router.js       — standalone SPA router (emitted on every page when
//     `router.enabled` is on, even without islands).
// The named inputs + "[name].js" filenames keep the public URLs stable at
// /_elur/entry-client.js and /_elur/router.js. Keeping a single input is
// still supported — the router then stays embedded in entry-client.js
// (legacy combined mode).
export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(__dirname, "dist/_elur"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "entry-client": resolve(__dirname, ".elur/entry-client.ts"),
        router: resolve(__dirname, ".elur/router.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        format: "es",
      },
    },
  },
});
