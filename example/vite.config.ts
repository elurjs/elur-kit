import { defineConfig } from "vite";
import { elurJsKit } from "@elurjs/kit/vite";

export default defineConfig({
  plugins: [
    elurJsKit({
      appDir: "src/app",
      islandsDir: "src/islands",
      generatedEntry: ".elur/entry-client.ts",
      clientEntry: "/_elur/entry-client.js",
      lang: "es",
    }),
  ],
});
