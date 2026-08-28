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
