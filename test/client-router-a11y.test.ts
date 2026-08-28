import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

// Tests for the accessibility and concurrent navigation improvements in the
// client router: aria-live announcements, focus management, canonical URL
// updates, and concurrent navigation cancellation.

describe("client router: accessibility & concurrency", () => {
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
    g.DOMParser = window.DOMParser;
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
    const mod = await import("../src/router/client.ts");
    mod.__resetRouterState();
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
    delete g.DOMParser;
    delete g.IntersectionObserver;
    delete g.MutationObserver;
    delete g.matchMedia;
    delete g.AbortController;
    globalThis.fetch = originalFetch;
    window.happyDOM.close();
  });

  it("creates an aria-live announcer on navigation", async () => {
    window.document.body.innerHTML = '<div id="app"><p>old</p></div>';
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ title: "About Page", body: "<p>about</p>" }),
    }) as Response) as typeof fetch;

    const { navigateTo } = await import("../src/router/client.ts");
    await navigateTo("/about", "", true);

    const announcer = window.document.getElementById("elur-route-announcer");
    assert.ok(announcer, "announcer should exist");
    assert.equal(announcer?.getAttribute("aria-live"), "assertive");
    assert.equal(announcer?.getAttribute("role"), "status");
  });

  it("updates canonical URL after navigation", async () => {
    window.document.body.innerHTML = '<div id="app"><p>old</p></div>';
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ title: "New", body: "<p>new</p>" }),
    }) as Response) as typeof fetch;

    const { navigateTo } = await import("../src/router/client.ts");
    await navigateTo("/about", "?q=1", true);

    const canonical = window.document.querySelector('link[rel="canonical"]');
    assert.ok(canonical, "canonical link should exist");
    assert.ok(canonical?.getAttribute("href")?.includes("/about"), "canonical should point to /about");
  });

  it("creates og:url meta tag after navigation", async () => {
    window.document.body.innerHTML = '<div id="app"><p>old</p></div>';
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ title: "New", body: "<p>new</p>" }),
    }) as Response) as typeof fetch;

    const { navigateTo } = await import("../src/router/client.ts");
    await navigateTo("/profile", "", true);

    const ogUrl = window.document.querySelector('meta[property="og:url"]');
    assert.ok(ogUrl, "og:url should exist");
    assert.ok(ogUrl?.getAttribute("content")?.includes("/profile"));
  });

  it("sets tabindex=-1 on #app for focus management", async () => {
    window.document.body.innerHTML = '<div id="app"><p>old</p></div>';
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ title: "New", body: "<p>new</p>" }),
    }) as Response) as typeof fetch;

    const { navigateTo } = await import("../src/router/client.ts");
    await navigateTo("/page", "", true);

    const app = window.document.getElementById("app");
    assert.ok(app?.hasAttribute("tabindex"), "#app should have tabindex for focus");
  });

  it("cancels previous in-flight navigation when a new one starts", async () => {
    window.document.body.innerHTML = '<div id="app"><p>old</p></div>';

    // Track which pages were actually swapped into #app.
    let swappedContent: string[] = [];
    const mockFetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      // Slow page: delay the response so a faster navigation can supersede it.
      if (url.includes("page=slow")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          ok: true,
          json: async () => ({ title: "Slow", body: "<p>SLOW SHOULD NOT APPEAR</p>" }),
        } as Response;
      }
      // Fast page: respond immediately.
      return {
        ok: true,
        json: async () => ({ title: "Fast", body: "<p>fast content</p>" }),
      } as Response;
    }) as typeof fetch;
    globalThis.fetch = mockFetch;

    const { navigateTo } = await import("../src/router/client.ts");

    // Start a slow navigation (don't await yet).
    const slowPromise = navigateTo("/slow", "", true);
    // Give it a tick to start fetching.
    await new Promise((r) => setTimeout(r, 10));
    // Immediately start a fast navigation (should cancel the slow one).
    const fastResult = await navigateTo("/fast", "", true);

    assert.equal(fastResult, true, "fast navigation should succeed");
    assert.equal(
      window.document.getElementById("app")?.innerHTML,
      "<p>fast content</p>",
      "fast content should be in #app",
    );

    // Wait for the slow navigation to complete — it should NOT have swapped
    // its content because it was superseded.
    await slowPromise.catch(() => { });
    assert.notEqual(
      window.document.getElementById("app")?.innerHTML,
      "<p>SLOW SHOULD NOT APPEAR</p>",
      "slow content should not have been swapped",
    );
  });

  it("dispatches elur:rendered event after navigation", async () => {
    window.document.body.innerHTML = '<div id="app"><p>old</p></div>';
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ title: "New", body: "<p>new</p>" }),
    }) as Response) as typeof fetch;

    const { navigateTo } = await import("../src/router/client.ts");

    let eventFired = false;
    window.document.addEventListener("elur:rendered", () => {
      eventFired = true;
    });

    await navigateTo("/page", "", true);
    assert.ok(eventFired, "elur:rendered event should fire");
  });
});
