// --- raw() helper: inject pre-rendered HTML without escaping ---
//
// Elur templates escape interpolated values by default. When rendering
// Markdown or other trusted HTML, we need to bypass that escaping. `raw()`
// creates a ElurTemplate that inserts the HTML string directly, the same
// pattern used by `island()` for server-side rendering.

import { ELUR_RENDER_PROTOCOL, type ElurTemplate } from "@elurjs/core";

/**
 * Creates a ElurTemplate that renders the given HTML string without escaping.
 *
 * **Security:** Only use `raw()` with trusted content (e.g. Markdown you
 * authored, or HTML you generated and sanitized). Never use it with
 * user-supplied input without sanitization.
 */
export function raw(html: string): ElurTemplate {
  return {
    __isElurTemplate: true as const,
    [ELUR_RENDER_PROTOCOL]: {
      renderServer: () => html,
    },
    mount(container: Element | string) {
      const el = typeof container === "string" ? document.querySelector(container) : container;
      if (!el) throw new Error("[elur-kit] raw(): container not found");
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
  } as unknown as ElurTemplate;
}
