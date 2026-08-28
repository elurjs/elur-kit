import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "../src/build/build.ts";
import { doPreview } from "../src/cli.ts";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "fixtures/minimal");
const appDir = resolve(root, "src/app");
const outDir = resolve(root, "dist");
const islandsDir = resolve(root, "src/islands");
const generatedDir = resolve(root, ".elur");

function stripMarkers(html: string): string {
  return html.replace(/<!--elur-\d+-->/g, "").replace(/<!--elur-end-\d+-->/g, "");
}

describe("preview server", () => {
  after(async () => {
    await rm(outDir, { recursive: true, force: true });
    await rm(generatedDir, { recursive: true, force: true });
  });

  it("serves static files and handles actions", async () => {
    await rm(outDir, { recursive: true, force: true });
    await build({
      appDir,
      outDir,
      islandsDir,
      generatedEntry: resolve(generatedDir, "entry-client.ts"),
      hydrateImport: "../../../src/island/index.ts",
    });

    const server = await doPreview({
      command: "preview",
      root,
      appDir,
      outDir,
      islandsDir,
      clientEntry: "/_elur/entry-client.js",
      lang: "es",
      hydrateImport: "../../../src/island/index.ts",
      port: 3463,
      host: "127.0.0.1",
      generatedEntry: ".elur/entry-client.ts",
    });

    try {
      const page = await fetch("http://127.0.0.1:3463/");
      assert.equal(page.status, 200);
      const body = await page.text();
      assert.ok(stripMarkers(body).includes("<h1>Hello from test</h1>"), "Preview should serve built home page");

      const action = await fetch("http://127.0.0.1:3463/__elur-js/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ name: "greet", page: "/", args: ["Ada"] }),
      });
      assert.equal(action.status, 200);
      assert.equal(await action.json(), "Hello, Ada!");
    } finally {
      server.close();
    }
  });
});
