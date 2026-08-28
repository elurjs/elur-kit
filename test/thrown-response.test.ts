import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../src/ssr/render.ts";
import type { PageRoute } from "../src/router/route-scanner.ts";

// Mock importer that returns a page module whose loader throws a Response.
const mockImporter = async (path: string): Promise<Record<string, unknown>> => {
  if (path.endsWith("page.ts")) {
    return {
      default: () => ({ __isElurTemplate: true, mount: () => ({ unmount() { } }), _render: () => () => { } }),
    };
  }
  if (path.endsWith("page.data.ts")) {
    return {
      load: async () => {
        // Simulate the documented pattern: throw new Response(..., { status: 404 })
        throw new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
      },
    };
  }
  return {};
};

const mockRoute: PageRoute = {
  path: "/test",
  pagePath: "/test/page.ts",
  dataPath: "/test/page.data.ts",
  layouts: [] as string[],
  params: [],
};

describe("throw new Response() as first-class (A-22)", () => {
  it("captures thrown Response from loader and returns it", async () => {
    const result = await renderPage({
      route: mockRoute,
      params: {},
      searchParams: new URLSearchParams(),
      config: { lang: "en", clientEntry: undefined, renderEndpoint: true },
      actions: {} as Record<string, string[]>,
      importer: mockImporter,
    });

    assert.ok(result.response, "should capture the thrown Response");
    assert.equal(result.response!.status, 404);
    const body = await result.response!.text();
    assert.equal(body, "Not Found");
  });

  it("captures thrown redirect Response from loader", async () => {
    const redirectImporter = async (path: string): Promise<Record<string, unknown>> => {
      if (path.endsWith("page.ts")) {
        return {
          default: () => ({ __isElurTemplate: true, mount: () => ({ unmount() { } }), _render: () => () => { } }),
        };
      }
      if (path.endsWith("page.data.ts")) {
        return {
          load: async () => {
            throw new Response(null, {
              status: 302,
              headers: { Location: "/login" },
            });
          },
        };
      }
      return {};
    };

    const result = await renderPage({
      route: mockRoute,
      params: {},
      searchParams: new URLSearchParams(),
      config: { lang: "en", clientEntry: undefined, renderEndpoint: true },
      actions: {} as Record<string, string[]>,
      importer: redirectImporter,
    });

    assert.ok(result.response, "should capture the redirect Response");
    assert.equal(result.response!.status, 302);
    assert.equal(result.response!.headers.get("Location"), "/login");
  });

  it("propagates non-Response errors as exceptions", async () => {
    const errorImporter = async (path: string): Promise<Record<string, unknown>> => {
      if (path.endsWith("page.ts")) {
        return {
          default: () => ({ __isElurTemplate: true, mount: () => ({ unmount() { } }), _render: () => () => { } }),
        };
      }
      if (path.endsWith("page.data.ts")) {
        return {
          load: async () => {
            throw new Error("database connection failed");
          },
        };
      }
      return {};
    };

    await assert.rejects(
      () => renderPage({
        route: mockRoute,
        params: {},
        searchParams: new URLSearchParams(),
        config: { lang: "en", clientEntry: undefined, renderEndpoint: true },
        actions: {} as Record<string, string[]>,
        importer: errorImporter,
      }),
      /database connection failed/,
    );
  });
});
