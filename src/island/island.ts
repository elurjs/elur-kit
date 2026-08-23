import { NIX_RENDER_PROTOCOL, type NixTemplate, type ServerRenderProtocolContext } from "@deijose/nix-js";

// --- Islands helper ---
//
// Marks a component as an island. During server-side rendering it emits a
// static placeholder with `data-nix-js-island` attributes. The client entry finds
// these markers and hydrates them with the real component + reactive signals.
//

export type IslandDirective = "load" | "idle" | "visible";

export interface IslandComponent<TProps = unknown> {
  (props: TProps): NixTemplate | null | false | undefined;
}

/**
 * Renders a component to a static HTML string with island markers.
 *
 * @param name Unique island name used by the client entry to look up the module.
 * @param component Server-side island component.
 * @param props Props passed to the component and serialized for hydration.
 * @param directive When to hydrate on the client.
 * @returns A NixTemplate that renders the island placeholder.
 */
export function island<TProps>(
  name: string,
  component: IslandComponent<TProps>,
  props: TProps,
  directive: IslandDirective = "load",
): NixTemplate {
  const markerHtml = (innerHtml: string) =>
    `<div data-nix-js-island="${escapeHtml(name)}" data-directive="${directive}" data-props='${serializeProps(props)}'>${innerHtml}</div>`;

  return {
    __isNixTemplate: true as const,
    [NIX_RENDER_PROTOCOL]: {
      async renderServer(context: ServerRenderProtocolContext) {
        const template = component(props);
        const innerHtml = template === null || template === false || template === undefined
          ? ""
          : await context.render(template, { markers: true });
        return markerHtml(innerHtml);
      },
    },
    _render(parent: Node, before: Node | null): () => void {
      const container = document.createElement("div");
      const template = component(props);
      let innerHtml = "";
      if (template !== null && template !== false && template !== undefined) {
        const dispose = template._render(container, null);
        innerHtml = container.innerHTML;
        dispose();
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
