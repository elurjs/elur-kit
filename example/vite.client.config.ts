import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(__dirname, "dist/_elur"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, ".elur/entry-client.ts"),
      output: {
        entryFileNames: "entry-client.js",
        format: "es",
      },
    },
  },
});
