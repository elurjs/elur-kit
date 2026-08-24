// --- Shared image registry (build-time singleton) ---
//
// This module owns the mutable state the image pipeline relies on:
//   * `renderRegistry`  — images registered by `image()` during a render pass.
//   * `activeManifest`  — the processed manifest used to emit `<picture>`.
//
// It MUST stay in its own chunk (`dist/lib/image/registry.js`) so that both the
// CLI bundle (`dist/lib/cli.js`) and the library entry (`dist/lib/image/index.js`)
// import the *same* physical module instance. If the registry state is inlined
// into the CLI, `consumeImageRegistry()` reads a different (empty) array than
// the one the app's `image()` calls populated, and the two-pass build silently
// processes nothing. Both vite configs externalize this chunk to enforce that.

import type { ImageManifest } from "./service.js";

export type ImageFormat = "webp" | "avif" | "jpeg" | "png";

export interface RegisteredImage {
  src: string;
  widths: number[];
  formats: ImageFormat[];
}

const renderRegistry: RegisteredImage[] = [];

/**
 * The active image manifest (if loaded). When set, image() emits real
 * <picture>/<source> markup from the manifest instead of a plain <img>.
 */
let activeManifest: ImageManifest | null = null;

/**
 * Set the active image manifest. Called by the build pipeline after
 * processing, or by the SSR server on startup.
 */
export function setImageManifest(manifest: ImageManifest | null): void {
  activeManifest = manifest;
}

/**
 * Returns the currently active image manifest (or null). Used by `image()`
 * to decide between `<picture>` (manifest present) and plain `<img>`.
 */
export function getActiveManifest(): ImageManifest | null {
  return activeManifest;
}

/**
 * Returns the images registered during the current render pass and clears
 * the registry. Called by the build pipeline after rendering all pages.
 */
export function consumeImageRegistry(): RegisteredImage[] {
  const items = [...renderRegistry];
  renderRegistry.length = 0;
  return items;
}

/**
 * Registers an image for build-time processing (if sharp is available).
 */
export function registerImage(src: string, widths: number[]): void {
  // Avoid duplicates in the same render pass.
  const existing = renderRegistry.find(
    (r) => r.src === src && r.widths.join(",") === widths.join(","),
  );
  if (!existing) {
    renderRegistry.push({ src, widths, formats: ["webp", "avif"] });
  }
}
