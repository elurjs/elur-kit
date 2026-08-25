import { NIX_RENDER_PROTOCOL, type NixTemplate, type ServerRenderProtocolContext } from "@deijose/nix-js";

// --- Islands helper ---
//
// Marks a component as an island. During server-side rendering it emits a
// static placeholder with `data-nix-js-island` attributes. The client entry finds
// these markers and hydrates them with the real component + reactive signals.
//
// SSR strategy
// ------------
// By default the component is executed on the server to produce a fallback HTML
// fragment (better first paint, SEO, less layout shift). Components that access
// browser-only globals (`document`, `window`, `navigator`, ...) in their body
// cannot run on the server. Two opt-out mechanisms are provided, mirroring the
// industry standard (Astro `client:only`, Next.js `dynamic(..., { ssr: false })`):
//
//   1. directive: "only"  — shortcut for client-only with `load` scheduling.
//   2. options: { ssr: false } — client-only with any directive (load/idle/visible).
//
// When SSR is skipped, only `options.fallback` (a NixTemplate or string) is
// rendered into the marker. The client hydrates from scratch.
//
// When SSR runs and the component throws, the error is NOT swallowed: it is
// re-thrown wrapped with an actionable message naming the island and suggesting
// `directive: "only"` / `{ ssr: false }` / `isSSR()`. This matches Astro and
// Next.js, which never try/catch to "auto-detect" client-only components.

export type IslandDirective = "load" | "idle" | "visible" | "only";

export interface IslandComponent<TProps = unknown> {
  (props: TProps): NixTemplate | null | false | undefined;
}

/**
 * Options for {@link island}.
 *
 * - `ssr`: Whether to execute the component on the server. Defaults to `true`
 *   unless `directive === "only"` (then `false`). When `false`, the component
 *   is never called during SSR; only `fallback` is rendered.
 * - `fallback`: HTML to render inside the island marker when SSR is skipped or
 *   the component returns null/false. Accepts a `NixTemplate` (reactive, with
 *   signals) or a plain string. Defaults to an empty string.
 */
export interface IslandOptions {
  ssr?: boolean;
  fallback?: NixTemplate | string;
}

/**
 * Renders a component to a static HTML string with island markers.
 *
 * @param name Unique island name used by the client entry to look up the module.
 * @param component Island component. Executed on the server unless `directive`
 *   is `"only"` or `options.ssr` is `false`.
 * @param props Props passed to the component and serialized for hydration.
 * @param directive When to hydrate on the client. Use `"only"` to skip SSR
 *   entirely (client-only island).
 * @param options SSR strategy and fallback content.
 * @returns A NixTemplate that renders the island placeholder.
 */
export function island<TProps>(
  name: string,
  component: IslandComponent<TProps>,
  props: TProps,
  directive: IslandDirective = "load",
  options?: IslandOptions,
): NixTemplate {
  // `directive: "only"` forces ssr off; explicit `options.ssr` wins otherwise.
  const ssr = directive === "only" ? false : (options?.ssr ?? true);
  const fallback = options?.fallback;

  const markerHtml = (innerHtml: string) =>
    `<div data-nix-js-island="${escapeHtml(name)}" data-directive="${directive}" data-props='${serializeProps(props)}'>${innerHtml}</div>`;

  return {
    __isNixTemplate: true as const,
    [NIX_RENDER_PROTOCOL]: {
      async renderServer(context: ServerRenderProtocolContext) {
        let innerHtml = "";
        if (ssr) {
          try {
            const template = component(props);
            if (template !== null && template !== false && template !== undefined) {
              innerHtml = await context.render(template, { markers: true });
            } else {
              // Component returned null/false/undefined — render fallback if any.
              innerHtml = await renderFallback(fallback, context);
            }
          } catch (error) {
            throw wrapIslandSSRError(name, error);
          }
        } else {
          innerHtml = await renderFallback(fallback, context);
        }
        return markerHtml(innerHtml);
      },
    },
    _render(parent: Node, before: Node | null): () => void {
      const container = document.createElement("div");
      let innerHtml = "";
      if (ssr) {
        const template = component(props);
        if (template !== null && template !== false && template !== undefined) {
          const dispose = template._render(container, null);
          innerHtml = container.innerHTML;
          dispose();
        } else {
          // null/false/undefined — render fallback if any.
          innerHtml = renderFallbackSync(fallback, container);
        }
      } else {
        innerHtml = renderFallbackSync(fallback, container);
      }
      const wrapper = document.createElement("template");
      wrapper.innerHTML = markerHtml(innerHtml);
      const fragment = wrapper.content;
      const inserted = fragment.firstChild;
      parent.insertBefore(fragment, before);
      return () => {
        if (inserted?.parentNode) inserted.parentNode.removeChild(inserted);
      };
    },
  } as unknown as NixTemplate;
}

/**
 * Wraps an SSR error from an island component with an actionable message.
 *
 * Following the Astro/Next.js convention, SSR errors are never silently
 * swallowed — they propagate so real bugs surface. The wrapper adds the island
 * name and three concrete remediation paths.
 */
function wrapIslandSSRError(name: string, error: unknown): Error {
  const cause = error instanceof Error ? error : new Error(String(error));
  const msg = error instanceof Error ? error.message : String(error);
  return new Error(
    `[nix-js-kit] Island "${name}" threw during SSR: ${msg}\n` +
    `  If the component accesses browser-only globals (document, window, etc.),\n` +
    `  use directive: "only" or options: { ssr: false } to skip server rendering.\n` +
    `  For environment reads (matchMedia, localStorage, navigator) you may guard\n` +
    `  the access with isSSR() from "@deijose/nix-js-kit".`,
    { cause },
  );
}

/** Renders the fallback (NixTemplate or string) to an HTML string on the server. */
async function renderFallback(
  fallback: NixTemplate | string | undefined,
  context: ServerRenderProtocolContext,
): Promise<string> {
  if (fallback == null || fallback === "") return "";
  if (typeof fallback === "string") return fallback;
  return context.render(fallback, { markers: false });
}

/** Renders the fallback into a container and returns its innerHTML (client path). */
function renderFallbackSync(fallback: NixTemplate | string | undefined, container: HTMLElement): string {
  if (fallback == null || fallback === "") return "";
  if (typeof fallback === "string") return fallback;
  const dispose = fallback._render(container, null);
  const html = container.innerHTML;
  dispose();
  return html;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function serializeProps(props: unknown): string {
  return JSON.stringify(props ?? null)
    .replace(/</g, "\\u003c")
    .replace(/'/g, "\\u0027");
}
