import type { ElurTemplate } from "@elurjs/core";
import { renderToString as renderCoreTemplate } from "@elurjs/core/server";
import { setSSR } from "./ssr-flag";

// --- Build-time / server rendering ---
//
// The Elur core ships a DOM-free `renderToString` (`@elurjs/core/server`)
// that streams template output without ever touching a `document`. The kit used
// to inject a Node-side DOM (happy-dom) as a fallback for legacy compatibility;
// that fallback has been removed together with the happy-dom dependency.

/**
 * Renders a Elur template to an HTML string in Node.
 *
 * Accepts a *factory* (not a template) because `html`` evaluates at call time.
 *
 * @param factory Thunk that builds the template, e.g. `() => Page({ data })`.
 * @returns Serialized HTML of the rendered template.
 */
export async function renderToString(
  factory: () => ElurTemplate,
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
