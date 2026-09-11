import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

// These tests verify the client-side router logic (prefetch cache, head merge,
// navigation) using happy-dom as the DOM environment.

describe("client router: prefetch cache", () => {
  let window: Window;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    window = new Window({ url: "http://localhost/" });
    const g = globalThis as Record<string, unknown>;
    g.document = window.document;
    g.window = window;
    g.location = window.location;
    g.history = window.history;
    g.CustomEvent = window.CustomEvent;
    g.Event = window.Event;
    g.Node = window.Node;
    g.Element = window.Element;
    g.HTMLElement = window.HTMLElement;
    g.IntersectionObserver = class {
      observe() { }
      unobserve() { }
      disconnect() { }
    };
    g.MutationObserver = class {
      observe() { }
      disconnect() { }
    };
    g.matchMedia = () => ({ matches: false }) as any;
    g.AbortController = window.AbortController;
    originalFetch = globalThis.fetch;

    // Reset router internal state for test isolation.
    const { __resetRouterState } = await import("../src/router/client.ts");
    __resetRouterState();
  });

  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    delete g.document;
    delete g.window;
    delete g.location;
    delete g.history;
    delete g.CustomEvent;
    delete g.Event;
    delete g.Node;
    delete g.Element;
    delete g.HTMLElement;
    delete g.IntersectionObserver;
    delete g.MutationObserver;
    delete g.matchMedia;
    delete g.AbortController;
    globalThis.fetch = originalFetch;
    window.happyDOM.close();
  });

  it("navigateTo fetches and swaps content", async () => {
    // Set up the DOM with an #app container.
    window.document.body.innerHTML = '<div id="app"><p>old</p></div>';

    // Mock fetch to return a render payload.
    let fetchedUrls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      fetchedUrls.push(url);
      return {
        ok: true,
        json: async () => ({ title: "New Page", body: "<p>new content</p>" }),
      } as Response;
    }) as typeof fetch;

    const { navigateTo } = await import("../src/router/client.ts");
    const ok = await navigateTo("/about", "", true);
    assert.equal(ok, true);
    assert.ok(fetchedUrls.length > 0, "should have fetched the render endpoint");
    assert.ok(fetchedUrls[0].includes("/__elur-js/render"), "should call the render endpoint");
    assert.equal(window.document.getElementById("app")?.innerHTML, "<p>new content</p>");
    assert.equal(window.document.title, "New Page");
  });

  it("navigateTo returns false on fetch failure", async () => {
    window.document.body.innerHTML = '<div id="app"><p>old</p></div>';
    globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) }) as Response) as typeof fetch;

    const { navigateTo } = await import("../src/router/client.ts");
    const ok = await navigateTo("/broken", "", true);
    assert.equal(ok, false);
  });

  it("navigateTo returns false when #app is missing", async () => {
    window.document.body.innerHTML = "";
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ body: "<p>new</p>" }),
    }) as Response) as typeof fetch;

    const { navigateTo } = await import("../src/router/client.ts");
    const ok = await navigateTo("/test", "", true);
    assert.equal(ok, false);
  });

  it("mergeHead replaces data-elur-head tags", async () => {
    window.document.head.innerHTML = `
      <meta charset="utf-8" />
      <meta data-elur-head name="description" content="old" />
      <title data-elur-head>Old Title</title>
    `;
    window.document.body.innerHTML = '<div id="app"><p>content</p></div>';

    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        title: "New Title",
        body: "<p>new</p>",
        head: '<title data-elur-head>New Title</title><meta data-elur-head name="description" content="new desc" />',
      }),
    }) as Response) as typeof fetch;

    const { navigateTo } = await import("../src/router/client.ts");
    await navigateTo("/page", "", true);

    // Old data-elur-head tags should be removed, new ones inserted.
    const metaTags = window.document.querySelectorAll('meta[data-elur-head]');
    assert.equal(metaTags.length, 1);
    assert.equal(metaTags[0].getAttribute("content"), "new desc");
    assert.equal(window.document.title, "New Title");
  });

  it("prefetch fetches without swapping content", async () => {
    window.document.body.innerHTML = '<div id="app"><p>original</p></div>';

    let fetchCount = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
      // Ignore probe requests (they use X-Elur-Probe header).
      if (init?.headers?.["X-Elur-Probe"]) {
        return { ok: true, json: async () => ({ body: "" }) } as Response;
      }
      fetchCount++;
      return {
        ok: true,
        json: async () => ({ title: "Prefetched", body: "<p>prefetched</p>" }),
      } as Response;
    }) as typeof fetch;

    const { prefetch, navigateTo } = await import("../src/router/client.ts");
    await prefetch("/cached-page", "");

    // Content should NOT have changed (prefetch doesn't swap).
    assert.equal(window.document.getElementById("app")?.innerHTML, "<p>original</p>");
    assert.equal(fetchCount, 1, "prefetch should fetch once");

    // Now navigate — should use the cache, not fetch again.
    await navigateTo("/cached-page", "", true);
    assert.equal(fetchCount, 1, "navigateTo should use the cache");
    assert.equal(window.document.getElementById("app")?.innerHTML, "<p>prefetched</p>");
  });

  it("clears action error cookie when provided", async () => {
    window.document.body.innerHTML = '<div id="app"><p>content</p></div>';

    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        body: "<p>new</p>",
        clearActionErrorCookie: "__elur_js_action_error=; Path=/; Max-Age=0",
      }),
    }) as Response) as typeof fetch;

    // Spy on the document.cookie setter (found by walking the prototype chain,
    // since happy-dom defines it on an internal Document prototype). happy-dom
    // does not reflect Max-Age=0 removals in document.cookie, so we assert the
    // router performs the clear-cookie write instead of relying on the read.
    let cookieWrite: string | null = null;
    let proto: unknown = window.document;
    let cookieDescriptor: PropertyDescriptor | undefined;
    while (proto) {
      const d = Object.getOwnPropertyDescriptor(proto, "cookie");
      if (d && d.set) { cookieDescriptor = d; break; }
      proto = Object.getPrototypeOf(proto);
    }
    assert.ok(cookieDescriptor, "happy-dom document.cookie setter should exist");
    const origSet = cookieDescriptor!.set!;
    const origGet = cookieDescriptor!.get!;
    Object.defineProperty(window.document, "cookie", {
      configurable: true,
      get() { return origGet.call(this); },
      set(value: string) { cookieWrite = value; origSet.call(this, value); },
    });

    const { navigateTo } = await import("../src/router/client.ts");
    await navigateTo("/page", "", true);

    assert.ok(cookieWrite, "router should write the clear cookie");
    assert.ok(cookieWrite!.startsWith("__elur_js_action_error="), `expected clear cookie, got ${cookieWrite}`);
  });
});

describe("client router: navigation lifecycle (A2/A3/9.x)", () => {
  let window: Window;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    window = new Window({ url: "http://localhost/" });
    const g = globalThis as Record<string, unknown>;
    g.document = window.document;
    g.window = window;
    g.location = window.location;
    g.history = window.history;
    g.CustomEvent = window.CustomEvent;
    g.Event = window.Event;
    g.Node = window.Node;
    g.Element = window.Element;
    g.HTMLElement = window.HTMLElement;
    g.IntersectionObserver = class {
      observe() { }
      unobserve() { }
      disconnect() { }
    };
    g.MutationObserver = class {
      observe() { }
      disconnect() { }
    };
    g.matchMedia = () => ({ matches: false }) as any;
    g.AbortController = window.AbortController;
    g.DOMParser = window.DOMParser;
    // Globals idiomorph touches when router.morph is enabled.
    g.Document = window.Document;
    g.DocumentFragment = window.DocumentFragment;
    g.TreeWalker = window.TreeWalker;
    g.NodeFilter = window.NodeFilter;
    originalFetch = globalThis.fetch;
    const { __resetRouterState } = await import("../src/router/client.ts");
    __resetRouterState();
  });

  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    delete g.document;
    delete g.window;
    delete g.location;
    delete g.history;
    delete g.CustomEvent;
    delete g.Event;
    delete g.Node;
    delete g.Element;
    delete g.HTMLElement;
    delete g.IntersectionObserver;
    delete g.MutationObserver;
    delete g.matchMedia;
    delete g.AbortController;
    delete g.DOMParser;
    delete g.Document;
    delete g.DocumentFragment;
    delete g.TreeWalker;
    delete g.NodeFilter;
    globalThis.fetch = originalFetch;
    window.happyDOM.close();
  });

  function mockRenderEndpoint(payload: Record<string, unknown>) {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (init?.headers?.["X-Elur-Probe"]) {
        return { ok: true, json: async () => ({ body: "" }) } as Response;
      }
      void url;
      return { ok: true, json: async () => payload } as Response;
    }) as typeof fetch;
  }

  it("dispatches navigate-start/navigate-end with detail {pathname,fromCache,popstate}", async () => {
    window.document.body.innerHTML = '<div id="app"><p>old</p></div>';
    mockRenderEndpoint({ title: "T", body: "<p>new</p>" });

    const events: Array<{ name: string; detail: Record<string, unknown> }> = [];
    for (const name of ["elur:navigate-start", "elur:navigate-end", "elur:navigate-error"]) {
      window.document.addEventListener(name, (e) => {
        events.push({ name, detail: (e as CustomEvent).detail });
      });
    }

    const { navigateTo } = await import("../src/router/client.ts");
    await navigateTo("/target", "", true);

    const names = events.map((e) => e.name);
    assert.deepEqual(names, ["elur:navigate-start", "elur:navigate-end"]);
    assert.equal(events[0].detail.pathname, "/target");
    // The third navigateTo arg is `push` — a pushed navigation is not a
    // popstate one.
    assert.equal(events[0].detail.popstate, false);
    assert.equal(events[1].detail.pathname, "/target");
    assert.equal(events[1].detail.fromCache, false);
  });

  it("reports popstate:true for back/forward navigations", async () => {
    window.document.body.innerHTML = '<div id="app"><p>old</p></div>';
    mockRenderEndpoint({ title: "T", body: "<p>back</p>" });

    const details: Array<Record<string, unknown>> = [];
    window.document.addEventListener("elur:navigate-end", (e) => {
      details.push((e as CustomEvent).detail);
    });

    const { navigateTo } = await import("../src/router/client.ts");
    await navigateTo("/prev", "", false);
    assert.equal(details[0]?.popstate, true);
    assert.equal(details[0]?.pathname, "/prev");
  });

  it("dispatches navigate-error when the payload cannot be fetched", async () => {
    window.document.body.innerHTML = '<div id="app"><p>old</p></div>';
    globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) }) as Response) as typeof fetch;

    const events: string[] = [];
    for (const name of ["elur:navigate-start", "elur:navigate-end", "elur:navigate-error"]) {
      window.document.addEventListener(name, () => events.push(name));
    }

    const { navigateTo } = await import("../src/router/client.ts");
    const ok = await navigateTo("/broken", "", true);
    assert.equal(ok, false);
    assert.deepEqual(events, ["elur:navigate-start", "elur:navigate-error"]);
  });

  it("dispatches elur:before-render BEFORE the #app swap (cleanup ordering)", async () => {
    window.document.body.innerHTML = '<div id="app"><p>old</p></div>';
    mockRenderEndpoint({ title: "T", body: "<p>new content</p>" });

    let oldStillAttached = false;
    window.document.addEventListener("elur:before-render", () => {
      // At before-render time the OLD body must still be in the DOM so
      // island disposers can locate their nodes (A2).
      oldStillAttached = window.document.getElementById("app")?.innerHTML.includes("old") ?? false;
    });

    const { navigateTo } = await import("../src/router/client.ts");
    await navigateTo("/x", "", true);
    assert.equal(oldStillAttached, true, "elur:before-render must fire before the swap");
    assert.equal(window.document.getElementById("app")?.innerHTML, "<p>new content</p>");
  });

  it("before-render detail announces the persisted nodes", async () => {
    window.document.body.innerHTML =
      '<div id="app"><div data-elur-persist="player"><span id="keep">k</span></div><p>old</p></div>';
    mockRenderEndpoint({
      title: "T",
      body: '<div data-elur-persist="player"><span id="keep">placeholder</span></div><p>new</p>',
    });

    let announced: number | null = null;
    window.document.addEventListener("elur:before-render", (e) => {
      announced = ((e as CustomEvent).detail?.persisted?.length ?? 0) as number;
    });

    const { navigateTo } = await import("../src/router/client.ts");
    await navigateTo("/y", "", true);
    assert.equal(announced, 1);
  });

  it("preserves data-elur-persist nodes across navigations (same element)", async () => {
    window.document.body.innerHTML =
      '<div id="app"><div data-elur-persist="player"><video id="player"></video></div><p>old</p></div>';
    const original = window.document.getElementById("player")!.parentElement!;

    mockRenderEndpoint({
      title: "T",
      body: '<p>new</p><div data-elur-persist="player"><video id="player"></video></div>',
    });

    const { navigateTo } = await import("../src/router/client.ts");
    await navigateTo("/persist", "", true);

    const now = window.document.getElementById("app")!.querySelector('[data-elur-persist="player"]');
    assert.equal(now, original, "persisted node must be the same element instance");
    // And it must be reinserted at the matching position (after the <p>new</p>).
    const app = window.document.getElementById("app")!;
    assert.equal(app.lastElementChild, original);
  });

  it("refreshes #elur-data / #elur-actions and re-inserts inline scripts", async () => {
    window.document.head.innerHTML = "";
    window.document.body.innerHTML = `
      <div id="app"><p>old</p></div>
      <script id="elur-data" type="application/json">{"title":"old"}</script>
      <script id="elur-actions" type="application/json">{"a":[]}</script>
    `;

    mockRenderEndpoint({
      title: "T",
      body: '<p>new</p><script>globalThis.marker = 1</script>',
      data: '{"title":"new"}',
      actions: '{"a":["b"]}',
    });

    const { navigateTo } = await import("../src/router/client.ts");
    await navigateTo("/refresh", "", true);

    assert.equal(
      window.document.getElementById("elur-data")?.textContent,
      '{"title":"new"}',
    );
    assert.equal(
      window.document.getElementById("elur-actions")?.textContent,
      '{"a":["b"]}',
    );
    // The script in the swapped body must be a fresh element (clone+insert
    // triggers execution in browsers — injected scripts are inert otherwise).
    const script = window.document.getElementById("app")!.querySelector("script");
    assert.ok(script, "inline script should survive the swap as a fresh element");
    assert.equal(script!.textContent, "globalThis.marker = 1");
  });

  it("bounds the prefetch cache at 32 entries (LRU)", async () => {
    window.document.body.innerHTML = '<div id="app"><p>x</p></div>';
    mockRenderEndpoint({ title: "T", body: "<p>b</p>" });

    const { prefetch } = await import("../src/router/client.ts");
    for (let i = 0; i < 40; i++) {
      await prefetch(`/p${i}`, "", { force: true });
    }

    // Re-prefetch the first page: it should have been evicted (miss → fetch).
    let fetches = 0;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (init?.headers?.["X-Elur-Probe"]) {
        return { ok: true, json: async () => ({ body: "" }) } as Response;
      }
      fetches++;
      return { ok: true, json: async () => ({ title: "T", body: "<p>b</p>" }) } as Response;
    }) as typeof fetch;
    await prefetch("/p39", "", { force: true });
    assert.equal(fetches, 0, "most recent entry should still be cached");
    await prefetch("/p0", "", { force: true });
    assert.equal(fetches, 1, "oldest entry should have been evicted");
    globalThis.fetch = prevFetch;
  });

  it("skips prefetch on Save-Data connections unless forced", async () => {
    const origNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: { connection: { saveData: true } },
    });
    try {
      let fetches = 0;
      globalThis.fetch = (async () => {
        fetches++;
        return { ok: true, json: async () => ({ body: "x" }) } as Response;
      }) as typeof fetch;

      const { prefetch } = await import("../src/router/client.ts");
      await prefetch("/a", "");
      assert.equal(fetches, 0, "Save-Data should skip prefetch");
      await prefetch("/a", "", { force: true });
      assert.equal(fetches >= 1, true, "forced prefetch bypasses the guard");
    } finally {
      if (origNavigator) {
        Object.defineProperty(globalThis, "navigator", origNavigator);
      } else {
        delete (globalThis as Record<string, unknown>).navigator;
      }
    }
  });

  it("sets history.scrollRestoration to manual on start", async () => {
    window.document.body.innerHTML = '<div id="app"></div>';
    const { startClientRouter } = await import("../src/router/client.ts");
    startClientRouter();
    if ("scrollRestoration" in window.history) {
      assert.equal(window.history.scrollRestoration, "manual");
    }
  });

  it("loading indicator appears for slow navigations and is removed on end", async () => {
    window.document.body.innerHTML = '<div id="app"><p>old</p></div>';
    let resolveFetch: ((r: unknown) => void) | null = null;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (init?.headers?.["X-Elur-Probe"]) {
        return { ok: true, json: async () => ({ body: "" }) } as Response;
      }
      return new Promise((res) => { resolveFetch = res; });
    }) as typeof fetch;

    const { startClientRouter, navigateTo } = await import("../src/router/client.ts");
    startClientRouter({ loadingIndicator: true });

    const nav = navigateTo("/slow", "", true);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (window.document.getElementById("elur-loading-indicator")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(
      window.document.getElementById("elur-loading-indicator"),
      "indicator should appear ~200ms into a slow navigation",
    );
    resolveFetch!({ ok: true, json: async () => ({ title: "T", body: "<p>slow done</p>" }) });
    await nav;
    // The bar fades out briefly after navigate-end; wait until removed.
    const removeDeadline = Date.now() + 2000;
    while (Date.now() < removeDeadline) {
      if (!window.document.getElementById("elur-loading-indicator")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(
      window.document.getElementById("elur-loading-indicator"),
      null,
      "indicator is removed on navigate-end",
    );
  });

  it("morph mode (idiomorph) swaps #app content and preserves persisted nodes", async () => {
    window.document.body.innerHTML =
      '<div id="app"><div data-elur-persist="player"><video id="player"></video></div><p>old</p></div>';
    const original = window.document.getElementById("player")!.parentElement!;
    mockRenderEndpoint({
      title: "Morphed",
      body: '<div data-elur-persist="player"><video id="player"></video></div><p>new</p>',
    });

    const { startClientRouter, navigateTo } = await import("../src/router/client.ts");
    startClientRouter({ morph: true });
    const ok = await navigateTo("/morph", "", true);

    assert.equal(ok, true);
    assert.ok(
      window.document.getElementById("app")!.innerHTML.includes("<p>new</p>"),
      "content updated after morph",
    );
    assert.equal(
      window.document.getElementById("app")!.querySelector('[data-elur-persist="player"]'),
      original,
      "persisted node keeps its identity under morphing",
    );
    assert.equal(window.document.title, "Morphed");
  });
});
