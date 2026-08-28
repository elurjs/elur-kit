import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "../src/build/build.ts";
import { nodeAdapter } from "../src/adapters/node.ts";
import { createWebHandler } from "../src/runtime/handler.ts";
import { createSsrServer } from "../src/ssr/server.ts";
import { scanRoutes } from "../src/router/route-scanner.ts";
import { scanActions } from "../src/action/scan.ts";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "fixtures/minimal");
const appDir = resolve(root, "src/app");
const outDir = resolve(root, "dist");
const islandsDir = resolve(root, "src/islands");
const generatedDir = resolve(root, ".elur");

const ROUTES = ["/", "/api/posts", "/does-not-exist"];

interface RuntimeProbe {
  name: string;
  fetch(pathname: string): Promise<{ status: number; type: string; body: string }>;
  close(): Promise<void>;
}

async function waitForServer(url: string, timeout = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.status !== undefined) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Server did not start at ${url}`);
}

async function buildFixture(): Promise<{ routes: Awaited<ReturnType<typeof scanRoutes>>; actions: Awaited<ReturnType<typeof scanActions>> }> {
  await rm(outDir, { recursive: true, force: true });
  await rm(generatedDir, { recursive: true, force: true });
  await build({
    appDir,
    outDir,
    islandsDir,
    generatedEntry: resolve(generatedDir, "entry-client.ts"),
    hydrateImport: "../../../src/island/index.ts",
  });
  const routes = await scanRoutes(appDir);
  const actions = await scanActions(appDir);
  return { routes, actions };
}

function toProbe(handler: (req: Request) => Promise<Response>): RuntimeProbe {
  return {
    name: "web-handler",
    async fetch(pathname) {
      const res = await handler(new Request(`http://127.0.0.1${pathname}`));
      return { status: res.status, type: res.headers.get("Content-Type") ?? "", body: await res.text() };
    },
    async close() { },
  };
}

function nodeAdapterProbe(): RuntimeProbe {
  let child: ReturnType<typeof spawn> | null = null;
  return {
    name: "node-adapter",
    async fetch(pathname) {
      const res = await fetch(`http://127.0.0.1:3471${pathname}`);
      return { status: res.status, type: res.headers.get("Content-Type") ?? "", body: await res.text() };
    },
    async close() {
      child?.kill();
    },
    // Attach the child lazily via a setter below.
    _child: undefined,
  } as RuntimeProbe & { _child?: ReturnType<typeof spawn> };
}

function stripMarkers(html: string): string {
  return html.replace(/<!--elur-\d+-->/g, "").replace(/<!--elur-end-\d+-->/g, "");
}

describe("cross-runtime parity (§8.2)", () => {
  let routes: Awaited<ReturnType<typeof scanRoutes>>;
  let actions: Awaited<ReturnType<typeof scanActions>>;
  let probes: RuntimeProbe[];
  const children: ReturnType<typeof spawn>[] = [];
  const ssrServers: Awaited<ReturnType<typeof createSsrServer>>[] = [];

  before(async () => {
    const fixture = await buildFixture();
    routes = fixture.routes;
    actions = fixture.actions;
    const probesArr: RuntimeProbe[] = [];

    // 1. Unified web handler (in-process).
    const handler = createWebHandler(
      routes,
      actions,
      { staticRoot: outDir, lang: "es", clientEntry: "/_elur/entry-client.js", renderEndpoint: true },
    );
    probesArr.push(toProbe(handler));

    // 2. Node adapter server.
    await nodeAdapter.build({
      root,
      appDir: "src/app",
      outDir: "dist",
      islandsDir: "src/islands",
      clientEntry: "/_elur/entry-client.js",
      lang: "es",
      hydrateImport: "../../../src/island/index.ts",
    });
    const nodeChild = spawn("node", [resolve(generatedDir, "node-server.mjs")], {
      cwd: root,
      env: { ...process.env, PORT: "3471" },
    });
    children.push(nodeChild);
    await waitForServer("http://127.0.0.1:3471/");
    probesArr.push({
      name: "node-adapter",
      async fetch(pathname) {
        const res = await fetch(`http://127.0.0.1:3471${pathname}`);
        return { status: res.status, type: res.headers.get("Content-Type") ?? "", body: await res.text() };
      },
      async close() { },
    });

    // 3. createSsrServer (CLI `start` pipeline).
    const ssr = await createSsrServer({
      root,
      appDir,
      publicDir: outDir,
      clientEntry: "/_elur/entry-client.js",
      lang: "es",
      port: 3472,
      host: "127.0.0.1",
    });
    await ssr.listen();
    ssrServers.push(ssr);
    probesArr.push({
      name: "ssr-server",
      async fetch(pathname) {
        const res = await fetch(`http://127.0.0.1:3472${pathname}`);
        return { status: res.status, type: res.headers.get("Content-Type") ?? "", body: await res.text() };
      },
      async close() { },
    });

    probes = probesArr;
  });

  after(async () => {
    for (const child of children) child.kill();
    for (const server of ssrServers) await server.close();
    await rm(outDir, { recursive: true, force: true });
    await rm(generatedDir, { recursive: true, force: true });
  });

  it("serves the same status and body semantics across runtimes", async () => {
    const baseline = new Map<string, { status: number; body: string }>();
    for (const probe of probes) {
      for (const route of ROUTES) {
        const res = await probe.fetch(route);
        if (probe.name === "web-handler") {
          baseline.set(route, { status: res.status, body: res.body });
          continue;
        }
        const expected = baseline.get(route)!;
        assert.equal(res.status, expected.status, `[${probe.name}] status for ${route}`);
        if (res.status === 200 && route === "/") {
          assert.ok(stripMarkers(res.body).includes("Hello from test"), `[${probe.name}] home body for ${route}`);
        }
        if (route === "/api/posts") {
          assert.ok(res.body.includes("Hello"), `[${probe.name}] API body for ${route}`);
        }
      }
    }
  });

  it("returns consistent 404 semantics", async () => {
    const statuses = new Map<string, number>();
    for (const probe of probes) {
      const res = await probe.fetch("/does-not-exist");
      statuses.set(probe.name, res.status);
    }
    // Every runtime answers 404 (never 500) for unknown paths.
    for (const [name, status] of statuses) {
      assert.equal(status, 404, `[${name}] should be 404`);
    }
  });
});
