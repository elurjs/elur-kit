import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { html, signal } from "@elurjs/core";
import { island, type IslandComponent } from "../src/island/island.ts";
import { isSSR } from "../src/render/ssr-flag.ts";
import { renderToString } from "../src/render/render-to-string.ts";
import { hydrateIslands, cleanupHydratedIslands } from "../src/island/hydrate.ts";

// --- Tests for the hybrid client-only island fix (v2.4.3) ---
//
// Covers: directive "only", options.ssr:false, fallback (string + ElurTemplate),
// error wrapping (no silent swallow), isSSR() export, and backward compatibility
// for SSR-safe islands.

function installDomGlobals(window: Window): () => void {
  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  const keys = ["window", "document", "Node", "NodeFilter", "Comment", "Text", "Element", "HTMLElement"];
  for (const k of keys) {
    saved[k] = g[k];
    g[k] = (window as unknown as Record<string, unknown>)[k];
  }
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete g[k];
      else g[k] = saved[k];
    }
  };
}

function clientOnlyComponent(): IslandComponent<Record<string, never>> {
  // Accesses `document` at call time — crashes in Node without DOM globals.
  return () => {
    const slides = Array.from(document.querySelectorAll(".slide"));
    return html`<div>${slides.length} slides</div>`;
  };
}

describe("island client-only: directive \"only\"", () => {
  it("skips SSR entirely — component is never executed on the server", async () => {
    let calls = 0;
    const component: IslandComponent<Record<string, never>> = () => {
      calls++;
      return html`<p>client</p>`;
    };
    const out = await renderToString(() => island("C", component, {}, "only"));
    assert.equal(calls, 0, "component must not be called during SSR");
    assert.match(out, /data-elur-island="C"/);
    assert.match(out, /data-directive="only"/);
    assert.doesNotMatch(out, /client/, "no component HTML in SSR output");
  });

  it("emits an empty marker when no fallback is provided", async () => {
    const out = await renderToString(() =>
      island("C", clientOnlyComponent(), {}, "only"),
    );
    assert.match(out, /<div data-elur-island="C"[^>]*><\/div>/);
  });

  it("emits the string fallback inside the marker", async () => {
    const out = await renderToString(() =>
      island("C", clientOnlyComponent(), {}, "only", { fallback: "<p>Loading…</p>" }),
    );
    assert.match(out, /<p>Loading…<\/p>/);
  });

  it("emits a ElurTemplate fallback (reactive) inside the marker", async () => {
    const out = await renderToString(() =>
      island("C", clientOnlyComponent(), {}, "only", { fallback: html`<span class="skeleton">.</span>` }),
    );
    assert.match(out, /<span class="skeleton">.<\/span>/);
  });
});

describe("island client-only: options.ssr:false", () => {
  it("skips SSR while keeping a non-only directive (visible)", async () => {
    let calls = 0;
    const component: IslandComponent<Record<string, never>> = () => {
      calls++;
      return html`<p>client</p>`;
    };
    const out = await renderToString(() =>
      island("C", component, {}, "visible", { ssr: false }),
    );
    assert.equal(calls, 0);
    assert.match(out, /data-directive="visible"/);
    assert.doesNotMatch(out, /client/);
  });

  it("skips SSR with idle directive + fallback", async () => {
    const out = await renderToString(() =>
      island("C", clientOnlyComponent(), {}, "idle", { ssr: false, fallback: "loading" }),
    );
    assert.match(out, /data-directive="idle"/);
    assert.match(out, /loading/);
  });

  it("explicit ssr:true overrides and runs the component", async () => {
    let calls = 0;
    const component: IslandComponent<Record<string, never>> = () => {
      calls++;
      return html`<p>ssr</p>`;
    };
    const out = await renderToString(() =>
      island("C", component, {}, "load", { ssr: true }),
    );
    assert.equal(calls, 1);
    assert.match(out, /<p>ssr<\/p>/);
  });
});

describe("island SSR error wrapping (no silent swallow)", () => {
  it("re-throws with island name and remediation hint on document access", async () => {
    // No DOM globals installed → document is undefined → ReferenceError.
    const component: IslandComponent<Record<string, never>> = () => {
      void document.querySelectorAll(".slide");
      return html`<p>x</p>`;
    };
    await assert.rejects(
      () => renderToString(() => island("Carousel", component, {}, "load")),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /Island "Carousel" threw during SSR/);
        assert.match(msg, /directive: "only"/);
        assert.match(msg, /ssr: false/);
        return true;
      },
    );
  });

  it("re-throws real bugs (TypeError) with the wrapping, not silently", async () => {
    const component: IslandComponent<Record<string, never>> = () => {
      // Real bug: accessing a property on undefined crashes at template build.
      const obj: undefined = undefined as unknown as undefined;
      void obj.nonExistent;
      return html`<p>x</p>`;
    };
    await assert.rejects(
      () => renderToString(() => island("Buggy", component, {}, "load")),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /Island "Buggy" threw during SSR/);
        return true;
      },
    );
  });

  it("preserves the original error as `cause`", async () => {
    const original = new TypeError("boom");
    const component: IslandComponent<Record<string, never>> = () => {
      throw original;
    };
    await assert.rejects(
      () => renderToString(() => island("X", component, {}, "load")),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error & { cause?: unknown }).cause, original);
        return true;
      },
    );
  });
});

describe("island backward compatibility", () => {
  it("default directive 'load' with no options still SSR-renders the component", async () => {
    const component: IslandComponent<Record<string, never>> = () =>
      html`<button>Like</button>`;
    const out = await renderToString(() => island("Like", component, {}));
    assert.match(out, /<button>Like<\/button>/);
    assert.match(out, /data-directive="load"/);
  });

  it("component returning null renders an empty marker (no fallback)", async () => {
    const component = (() => null) as unknown as IslandComponent<Record<string, never>>;
    const out = await renderToString(() => island("Empty", component, {}));
    assert.match(out, /<div data-elur-island="Empty"[^>]*><\/div>/);
  });

  it("component returning null with a fallback renders the fallback", async () => {
    const component = (() => null) as unknown as IslandComponent<Record<string, never>>;
    const out = await renderToString(() =>
      island("Empty", component, {}, "load", { fallback: "<p>placeholder</p>" }),
    );
    assert.match(out, /<p>placeholder<\/p>/);
  });
});

describe("isSSR() export", () => {
  it("returns true during renderToString and false outside", async () => {
    assert.equal(isSSR(), false, "false outside of render");
    let captured: boolean | undefined;
    const component: IslandComponent<Record<string, never>> = () => {
      captured = isSSR();
      return html`<p>x</p>`;
    };
    await renderToString(() => island("S", component, {}));
    assert.equal(captured, true, "true inside render");
    assert.equal(isSSR(), false, "false again after render");
  });

  it("allows environment reads (matchMedia-style) to be SSR-safe", async () => {
    const width = signal(0);
    const component: IslandComponent<Record<string, never>> = () => {
      // Pattern: read window only on client; SSR uses a safe default.
      width.value = isSSR() ? 0 : (window.innerWidth ?? 0);
      return html`<span>${() => width.value}px</span>`;
    };
    const out = await renderToString(() => island("W", component, {}));
    // Hydration markers (<!--elur-N-->) may be interleaved; strip them before checking.
    const stripped = out.replace(/<!--elur-\d+-->/g, "").replace(/<!--elur-end-\d+-->/g, "");
    assert.match(stripped, /0px/);
  });
});

describe("island client _render path", () => {
  it("directive 'only' renders the fallback in the client _render path", () => {
    const window = new Window({ url: "http://localhost/" });
    const restore = installDomGlobals(window);
    try {
      const component: IslandComponent<Record<string, never>> = () => html`<p>never</p>`;
      const tpl = island("C", component, {}, "only", { fallback: "<p>fb</p>" });
      const container = document.createElement("div");
      tpl._render(container, null);
      const marker = container.querySelector('[data-elur-island="C"]');
      assert.ok(marker, "marker present");
      assert.equal(marker?.innerHTML, "<p>fb</p>");
      assert.doesNotMatch(marker!.innerHTML, /never/);
    } finally {
      restore();
    }
  });

  it("ssr:false renders the fallback in the client _render path", () => {
    const window = new Window({ url: "http://localhost/" });
    const restore = installDomGlobals(window);
    try {
      const component: IslandComponent<Record<string, never>> = () => html`<p>never</p>`;
      const tpl = island("C", component, {}, "visible", { ssr: false, fallback: "loading" });
      const container = document.createElement("div");
      tpl._render(container, null);
      const marker = container.querySelector('[data-elur-island="C"]');
      assert.equal(marker?.innerHTML, "loading");
    } finally {
      restore();
    }
  });
});

describe("island directive \"only\" client hydration (v2.4.4 regression fix)", () => {
  // Regression: v2.4.3 added "only" to the SSR side but forgot the hydrator.
  // hydrateIslands only handled "load"/"idle"/"visible" — markers with
  // data-directive="only" were never hydrated, leaving fallback HTML forever.

  it("hydrates directive 'only' islands immediately on the client", async () => {
    const window = new Window({ url: "http://localhost/" });
    const restore = installDomGlobals(window);
    try {
      // SSR output: empty marker (component skipped, no fallback)
      const out = await renderToString(() =>
        island("Counter", () => html`<button>Click</button>`, {}, "only"),
      );
      document.body.innerHTML = out;

      // Before hydration: marker is empty
      assert.equal(
        document.querySelector('[data-elur-island="Counter"]')?.innerHTML,
        "",
        "marker empty before hydration",
      );

      hydrateIslands({
        Counter: () => html`<button>Click</button>`,
      } as never);

      // "only" should hydrate immediately like "load" — no scheduling wait.
      // Give it a microtask for the async hydrate() to resolve.
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(
        document.querySelector('[data-elur-island="Counter"] button')?.textContent,
        "Click",
        "component hydrated into the marker",
      );
    } finally {
      cleanupHydratedIslands();
      restore();
    }
  });

  it("hydrates directive 'only' with fallback, replacing fallback with component", async () => {
    const window = new Window({ url: "http://localhost/" });
    const restore = installDomGlobals(window);
    try {
      const out = await renderToString(() =>
        island("Widget", () => html`<p>live</p>`, {}, "only", { fallback: "<p>loading</p>" }),
      );
      document.body.innerHTML = out;

      // Before: fallback visible
      assert.equal(
        document.querySelector('[data-elur-island="Widget"]')?.textContent,
        "loading",
      );

      hydrateIslands({
        Widget: () => html`<p>live</p>`,
      } as never);
      await new Promise((r) => setTimeout(r, 10));

      // After: component replaced fallback
      assert.equal(
        document.querySelector('[data-elur-island="Widget"]')?.textContent,
        "live",
      );
    } finally {
      cleanupHydratedIslands();
      restore();
    }
  });
});
