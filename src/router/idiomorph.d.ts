/**
 * Minimal ambient types for `idiomorph` (BSD-2-Clause) — the package ships
 * plain JS without a .d.ts. Only the surface the client router uses is
 * declared.
 */
declare module "idiomorph" {
  export interface IdiomorphCallbacks {
    beforeNodeMorphed?: (oldNode: Node, newContent: Node) => boolean | void;
    afterNodeMorphed?: (oldNode: Node, newContent: Node) => void;
    beforeNodeAdded?: (node: Node) => boolean | void;
    afterNodeAdded?: (node: Node) => void;
    beforeNodeRemoved?: (node: Node) => boolean | void;
    afterNodeRemoved?: (node: Node) => void;
    beforeAttributeUpdated?: (
      attributeName: string,
      node: Node,
      mutationType: "added" | "removed" | "updated" | null,
    ) => boolean | void;
  }

  export interface IdiomorphConfig {
    morphStyle?: "innerHTML" | "outerHTML";
    ignoreActive?: boolean;
    ignoreActiveValue?: boolean;
    restoreFocus?: boolean;
    callbacks?: IdiomorphCallbacks;
    head?: {
      style?: "merge" | "append" | "morph" | "none";
      shouldPreserve?: (elt: Element) => boolean;
      shouldReAppend?: (elt: Element) => boolean;
      shouldRemove?: (elt: Element) => boolean;
      afterHeadMorphed?: (oldHead: Element, newHead: Element) => void;
    };
  }

  export const Idiomorph: {
    morph(
      existingNode: Element | Document,
      newContent: string | Node | Node[] | HTMLCollection,
      config?: IdiomorphConfig,
    ): Node[] | undefined;
    defaults: IdiomorphConfig;
  };
}
