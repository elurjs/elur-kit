// --- raw() helper: inject pre-rendered HTML without escaping ---
//
// Nix.js templates escape interpolated values by default. When rendering
// Markdown or other trusted HTML, we need to bypass that escaping. `raw()`
// creates a NixTemplate that inserts the HTML string directly, the same
// pattern used by `island()` for server-side rendering.

import type { NixTemplate } from "@deijose/nix-js";

/**
 * Creates a NixTemplate that renders the given HTML string without escaping.
 *
 * **Security:** Only use `raw()` with trusted content (e.g. Markdown you
 * authored, or HTML you generated and sanitized). Never use it with
 * user-supplied input without sanitization.
 */
export function raw(html: string): NixTemplate {
  return {
    __isNixTemplate: true as const,
    mount(container: Element | string) {
      const el = typeof container === "string" ? document.querySelector(container) : container;
      if (!el) throw new Error("[nix-js-kit] raw(): container not found");
      el.innerHTML = html;
      return {
        unmount() {
          el.innerHTML = "";
        },
      };
    },
    _render(parent: Node, before: Node | null): () => void {
      const wrapper = document.createElement("template");
      wrapper.innerHTML = html;
      const fragment = wrapper.content;
      const inserted = Array.from(fragment.childNodes);
      parent.insertBefore(fragment, before);
      return () => {
        for (const node of inserted) {
          if (node.parentNode) node.parentNode.removeChild(node);
        }
      };
    },
  } as unknown as NixTemplate;
}
