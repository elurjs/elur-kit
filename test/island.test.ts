import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { html } from "@elurjs/core";
import { cleanupHydratedIslands, hydrateIslands, lazyIsland, type IslandRegistry } from "../src/island/hydrate.ts";
import { island, type IslandComponent } from "../src/island/island.ts";
import { renderToString } from "../src/render/render-to-string.ts";

function textTemplate(value: string) {
  return {
    __isElurTemplate: true as const,
    _render(parent: Node, before: Node | null) {
      const node = document.createTextNode(value);
      parent.insertBefore(node, before);
      return () => node.parentNode?.removeChild(node);
    },
  };
}

describe("island hydration", () => {
  let window: Window;

  beforeEach(() => {
    window = new Window({ url: "http://localhost/" });
    const globals = globalThis as Record<string, unknown>;
    globals.window = window;
    globals.document = window.document;
    globals.Node = window.Node;
    globals.NodeFilter = window.NodeFilter;
    globals.Comment = window.Comment;
    globals.Text = window.Text;
    globals.Element = window.Element;
    globals.HTMLElement = window.HTMLElement;
  });

  afterEach(() => {
    cleanupHydratedIslands();
    window.close();
  });

  it("treats null as an empty island and continues hydrating siblings", () => {
    document.body.innerHTML = [
      '<div data-elur-island="Empty" data-props="{}"><p>SSR fallback</p></div>',
      '<div data-elur-island="Ready" data-props="{}"></div>',
    ].join("");
    const registry = {
      Empty: () => null,
      Ready: () => textTemplate("hydrated"),
    } as unknown as IslandRegistry;

    assert.doesNotThrow(() => hydrateIslands(registry));
    assert.equal(document.querySelector('[data-elur-island="Empty"]')?.textContent, "SSR fallback");
    assert.equal(document.querySelector('[data-elur-island="Ready"]')?.textContent, "hydrated");
  });

  it("hydrates server markers without replacing the island DOM", async () => {
    let clicks = 0;
    const component = () => html`
        <button @click=${() => { clicks++; }}>${"Ready"}</button>
    `;
    document.body.innerHTML = await renderToString(() => island("Ready", component, {}));
    const button = document.querySelector("button")!;

    hydrateIslands({ Ready: component });

    assert.equal(document.querySelector("button"), button);
    button.click();
    assert.equal(clicks, 1);
  });

  it("renders an empty SSR marker when the component returns null", () => {
    const component = (() => null) as unknown as IslandComponent<Record<string, never>>;
    const template = island("Empty", component, {});
    const container = document.createElement("div");

    assert.doesNotThrow(() => template._render(container, null));
    assert.equal(container.querySelector('[data-elur-island="Empty"]')?.innerHTML, "");
  });

  it("isolates malformed props and hydrates valid siblings", () => {
    document.body.innerHTML = [
      '<div data-elur-island="Broken" data-props="{"><p>SSR fallback</p></div>',
      '<div data-elur-island="Ready" data-props="{}"></div>',
    ].join("");
    const registry = {
      Broken: () => textTemplate("broken"),
      Ready: () => textTemplate("hydrated"),
    } as unknown as IslandRegistry;

    assert.doesNotThrow(() => hydrateIslands(registry));
    assert.equal(document.querySelector('[data-elur-island="Broken"]')?.textContent, "SSR fallback");
    assert.equal(document.querySelector('[data-elur-island="Ready"]')?.textContent, "hydrated");
  });

  it("supports async (lazy) island loaders", async () => {
    document.body.innerHTML = '<div data-elur-island="Lazy" data-props="{}"></div>';
    const registry = {
      Lazy: async () => () => textTemplate("lazy-hydrated"),
    } as unknown as IslandRegistry;

    hydrateIslands(registry);
    // Wait for the async import to resolve.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(document.querySelector('[data-elur-island="Lazy"]')?.textContent, "lazy-hydrated");
  });

  it("isolates errors in one island and continues hydrating siblings", async () => {
    document.body.innerHTML = [
      '<div data-elur-island="Boom" data-props="{}"></div>',
      '<div data-elur-island="Ok" data-props="{}"></div>',
    ].join("");
    const registry = {
      Boom: () => { throw new Error("boom"); },
      Ok: () => textTemplate("ok"),
    } as unknown as IslandRegistry;

    assert.doesNotThrow(() => hydrateIslands(registry));
    assert.equal(document.querySelector('[data-elur-island="Ok"]')?.textContent, "ok");
  });

  it("warns when an island is not registered", () => {
    document.body.innerHTML = '<div data-elur-island="Missing" data-props="{}"><p>fallback</p></div>';
    const originalWarn = console.warn;
    let warned = false;
    console.warn = (msg: string) => { if (msg.includes("Missing")) warned = true; };
    try {
      hydrateIslands({} as IslandRegistry);
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(warned, "should warn about missing island");
    assert.equal(document.querySelector('[data-elur-island="Missing"]')?.textContent, "fallback");
  });
});

describe("island lazy loader detection (§10.3)", () => {
  it("resolves a discriminated { load } loader without invoking the component", async () => {
    document.body.innerHTML = '<div data-elur-island="Lazy" data-props="{}"></div>';
    let componentCalls = 0;
    const component: IslandComponent = () => {
      componentCalls++;
      return textTemplate("lazy-hydrated");
    };
    let loadCalls = 0;
    const registry = {
      Lazy: lazyIsland(() => {
        loadCalls++;
        return Promise.resolve(component);
      }),
    } as unknown as IslandRegistry;

    hydrateIslands(registry);
    assert.equal(loadCalls, 1, "loader should be called exactly once");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.querySelector('[data-elur-island="Lazy"]')?.textContent, "lazy-hydrated");
    assert.equal(componentCalls, 1, "component called once with real props, no probe call");
  });

  it("detects a legacy async loader without executing it as a probe", async () => {
    document.body.innerHTML = '<div data-elur-island="Legacy" data-props="{}"></div>';
    let calls = 0;
    const registry = {
      Legacy: (async () => {
        calls++;
        return () => textTemplate("legacy");
      }) as unknown,
    } as unknown as IslandRegistry;

    hydrateIslands(registry);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 1, "async loader executed once (not probed then called)");
    assert.equal(document.querySelector('[data-elur-island="Legacy"]')?.textContent, "legacy");
  });

  it("generates discriminated lazy loaders in the client entry", async () => {
    const { buildEntrySource } = await import("../src/island/generate-entry.ts");
    const source = buildEntrySource(
      [{ name: "Counter", filePath: "/project/src/islands/Counter.ts" }],
      "/project/.elur/entry-client.ts",
    );
    assert.ok(source.includes("{ load: () => import("), "should emit discriminated { load } loader");
  });
});

describe("island entry generator: lazy imports", () => {
  it("generates dynamic import() calls for code-splitting", async () => {
    const { buildEntrySource } = await import("../src/island/generate-entry.ts");
    const source = buildEntrySource(
      [
        { name: "Counter", filePath: "/project/src/islands/Counter.ts" },
        { name: "Search", filePath: "/project/src/islands/Search.ts" },
      ],
      "/project/.elur/entry-client.ts",
    );

    // Should use dynamic import() not static import.
    assert.ok(source.includes("import("), "should use dynamic import()");
    assert.ok(!source.match(/^import \w+ from/m), "should not use static imports for islands");
    assert.ok(source.includes('"Counter"'), "should register Counter");
    assert.ok(source.includes('"Search"'), "should register Search");
    assert.ok(source.includes("hydrateIslands(registry)"), "should call hydrateIslands");
  });

  it("generates empty entry when no islands exist", async () => {
    const { buildEntrySource } = await import("../src/island/generate-entry.ts");
    const source = buildEntrySource([], "/project/.elur/entry-client.ts");
    assert.ok(!source.includes("hydrateIslands(registry)"), "should not hydrate when no islands");
    assert.ok(source.includes("startClientRouter()"), "should still start the router");
  });
});
