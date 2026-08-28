import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ELUR_RENDER_PROTOCOL } from "@elurjs/core";
import { createStreamingResponse, createBufferedResponse, supportsStreaming } from "../src/ssr/stream-response.ts";
import { withBoundaryContext, getCurrentBoundaryContext } from "../src/middleware/stream-boundary.ts";
import type { PageRoute } from "../src/router/route-scanner.ts";

const mockRoute: PageRoute = {
  path: "/test",
  pagePath: "/test/page.ts",
  layouts: [] as string[],
  params: [],
};

const mockConfig = {
  lang: "en",
  clientEntry: undefined,
  renderEndpoint: true,
};

/** Creates a mock template that supports server rendering without a DOM. */
function mockTemplate(html: string) {
  return {
    __isElurTemplate: true as const,
    [ELUR_RENDER_PROTOCOL]: { renderServer: () => html },
    mount: () => ({ unmount() { } }),
    _render: () => () => { },
  };
}

describe("streaming response (plan §10)", () => {
  it("createStreamingResponse falls back to normal render without loading boundary", async () => {
    const importer = async (path: string): Promise<Record<string, unknown>> => {
      if (path.endsWith("page.ts")) {
        return { default: () => mockTemplate("<div>Hello</div>") };
      }
      return {};
    };

    const response = await createStreamingResponse({
      route: { ...mockRoute, loadingPath: undefined },
      params: {},
      searchParams: new URLSearchParams(),
      config: mockConfig,
      importer,
    });

    assert.ok(response.body, "should have a body");
    assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  });

  it("createBufferedResponse returns a complete Response", async () => {
    const importer = async (path: string): Promise<Record<string, unknown>> => {
      if (path.endsWith("page.ts")) {
        return { default: () => mockTemplate("<div>Buffered content</div>") };
      }
      return {};
    };

    const response = await createBufferedResponse({
      route: mockRoute,
      params: {},
      searchParams: new URLSearchParams(),
      config: mockConfig,
      importer,
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
    const text = await response.text();
    assert.ok(text.length > 0, "should have content");
  });

  it("supportsStreaming returns true by default", () => {
    assert.equal(supportsStreaming(), true);
    assert.equal(supportsStreaming({ streaming: true }), true);
  });

  it("supportsStreaming returns false when streaming is disabled", () => {
    assert.equal(supportsStreaming({ streaming: false }), false);
  });
});

describe("stream boundary context (per-request)", () => {
  it("withBoundaryContext creates an isolated context", () => {
    assert.equal(getCurrentBoundaryContext(), undefined);

    const result = withBoundaryContext(() => {
      const ctx = getCurrentBoundaryContext();
      assert.ok(ctx, "should have a context inside withBoundaryContext");
      assert.ok(ctx!.boundaries, "should have a boundaries map");
      return "ok";
    });

    assert.equal(result, "ok");
    assert.equal(getCurrentBoundaryContext(), undefined, "context should be cleaned up");
  });

  it("nested withBoundaryContext preserves outer context", () => {
    withBoundaryContext(() => {
      const outer = getCurrentBoundaryContext();
      assert.ok(outer);

      withBoundaryContext(() => {
        const inner = getCurrentBoundaryContext();
        assert.ok(inner);
        assert.notEqual(inner, outer, "inner should be a new context");
      });

      // After inner, outer should be restored.
      assert.equal(getCurrentBoundaryContext(), outer);
    });
  });
});
