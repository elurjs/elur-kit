import type { NixTemplate } from "@deijose/nix-js";
import { renderToString as renderCoreTemplate } from "@deijose/nix-js/server";
import { setSSR } from "./ssr-flag";

// --- Build-time / server rendering ---
//
// The Nix.js core ships a DOM-free `renderToString` (`@deijose/nix-js/server`)
// that streams template output without ever touching a `document`. The kit used
// to inject a Node-side DOM (happy-dom) as a fallback for legacy compatibility;
// that fallback has been removed together with the happy-dom dependency.

/**
 * Renders a Nix.js template to an HTML string in Node.
 *
 * Accepts a *factory* (not a template) because `html`` evaluates at call time.
 *
 * @param factory Thunk that builds the template, e.g. `() => Page({ data })`.
 * @returns Serialized HTML of the rendered template.
 */
export async function renderToString(
  factory: () => NixTemplate,
  options: { markers?: "none" | "hydration" } = {},
): Promise<string> {
  setSSR(true);
  try {
    return await renderCoreTemplate(factory(), {
      markers: options.markers ?? "hydration",
    });
  } finally {
    setSSR(false);
  }
}
