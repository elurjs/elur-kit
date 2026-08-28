// --- image() helper: optimized <img> / <picture> without dependencies ---
//
// Emits an `<img>` (or `<picture>` when processed variants are available) with:
//   - `srcset` / `sizes` for responsive images
//   - `loading="lazy"` and `decoding="async"` (unless `priority`)
//   - `width` / `height` to prevent layout shift (CLS)
//   - `fetchpriority="high"` for above-the-fold images
//
// When the build-time pipeline (sharp) is available, `image()` registers the
// source for processing and emits `<picture>` with `<source>` per format.
// When sharp is not installed, it falls back to a plain `<img>` with srcset
// pointing to the original file.

import { ELUR_RENDER_PROTOCOL, type ElurTemplate } from "@elurjs/core";
import { getManifestEntry, buildPictureMarkup } from "./service.js";
import {
  registerImage,
  getActiveManifest,
} from "./registry.js";

export { consumeImageRegistry, setImageManifest, type ImageFormat } from "./registry.js";

export interface ImageOptions {
  /** Source path relative to the public directory, e.g. "/images/hero.jpg". */
  src: string;
  /** Alt text (required for accessibility). */
  alt: string;
  /** Intrinsic width of the source image in pixels. */
  width: number;
  /** Intrinsic height of the source image in pixels. */
  height: number;
  /** Responsive widths to generate for srcset. Defaults to [width]. */
  widths?: number[];
  /** Sizes attribute for responsive layout, e.g. "100vw" or "(min-width: 768px) 50vw, 100vw". */
  sizes?: string;
  /** If true, loads eagerly with high priority (for above-the-fold images). */
  priority?: boolean;
  /** CSS class for the img element. */
  class?: string;
  /** Additional HTML attributes. */
  attributes?: Record<string, string>;
}

/**
 * Creates a ElurTemplate that renders an optimized `<img>` or `<picture>` element.
 *
 * When a manifest is active (post-build or SSR with manifest loaded):
 *   * Emits `<picture>` with `<source>` per format and real hashed variant URLs.
 *   * Uses real dimensions from the manifest.
 *
 * When no manifest is active (first build pass, dev without sharp):
 *   * Emits a plain `<img>` with the original src.
 *   * Does NOT emit srcset with unresolved variant URLs.
 *   * Registers the image for build-time processing.
 */
export function image(opts: ImageOptions): ElurTemplate {
  const {
    src,
    alt,
    width,
    height,
    widths = [width],
    sizes,
    priority = false,
    class: className,
    attributes = {},
  } = opts;

  // Register for build-time processing.
  registerImage(src, widths);

  // If a manifest is active and has an entry for this src, emit <picture>.
  let html: string;
  const manifest = getActiveManifest();
  const entry = manifest ? getManifestEntry(manifest, src) : undefined;
  if (entry && entry.variants.length > 0) {
    html = buildPictureMarkup(entry, {
      alt,
      sizes,
      priority,
      class: className,
      attributes,
      fallbackSrc: src,
      fallbackWidth: width,
      fallbackHeight: height,
    });
  } else {
    // No manifest or no variants: emit a plain <img> with the original src.
    // Do NOT emit srcset — the variant files don't exist yet.
    const loadingAttr = priority ? "" : ' loading="lazy"';
    const fetchPriorityAttr = priority ? ' fetchpriority="high"' : "";
    const sizesAttr = sizes ? ` sizes="${escapeAttr(sizes)}"` : "";
    const classAttr = className ? ` class="${escapeAttr(className)}"` : "";
    const extraAttrs = Object.entries(attributes)
      .map(([key, value]) => ` ${escapeAttr(key)}="${escapeAttr(String(value))}"`)
      .join("");
    html = `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" width="${width}" height="${height}"${sizesAttr}${loadingAttr} decoding="async"${fetchPriorityAttr}${classAttr}${extraAttrs} />`;
  }

  return {
    __isElurTemplate: true as const,
    [ELUR_RENDER_PROTOCOL]: {
      renderServer: () => html,
    },
    mount(container: Element | string) {
      const el = typeof container === "string" ? document.querySelector(container) : container;
      if (!el) throw new Error("[elur-kit] image(): container not found");
      el.innerHTML = html;
      return { unmount() { el.innerHTML = ""; } };
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

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export {
  processImageBatch,
  readManifest,
  writeManifest,
  getManifestEntry,
  buildSrcset,
  buildPictureMarkup,
  validateManifestUrls,
  isSharpAvailable,
  getImage,
  createImageService,
  transformHash,
} from "./service.js";
export type {
  ImageManifest,
  ImageEntry,
  ImageVariant,
  ProcessOptions,
  ProcessResult,
  ImageRequest,
  ImageMetadata,
  GeneratedImage,
  ImageService,
  ImageServiceCapabilities,
  ImageServiceContext,
} from "./service.js";
