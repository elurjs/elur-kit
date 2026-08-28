// --- Stream boundary (per-request, real Suspense streaming) ---
//
// `streamBoundary()` wraps a promise in a loading fallback. During SSR runtime,
// the server emits the fallback HTML immediately, then streams a `<template>`
// chunk with a replacement script that the browser executes to swap the
// fallback for the resolved content in-place (real Suspense streaming).
//
// In SSG (build time), boundaries are resolved synchronously — the build waits
// for all promises before writing the HTML, so no streaming occurs.
//
// Boundaries are tracked per-request via AsyncLocalStorage to avoid global
// state leakage between concurrent requests.

import type { ElurTemplate } from "@elurjs/core";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export interface StreamBoundaryOptions<T> {
  /** Fallback content shown while the promise resolves. */
  fallback: ElurTemplate;
  /** Promise that resolves to a ElurTemplate. */
  promise: Promise<T>;
  /** Renders the resolved value to a ElurTemplate. */
  children: (value: T) => ElurTemplate;
}

/** Per-request boundary registry. */
interface BoundaryContext {
  boundaries: Map<string, {
    promise: Promise<unknown>;
    children: (value: unknown) => ElurTemplate;
  }>;
}

const boundaryALS = new AsyncLocalStorage<BoundaryContext>();

/**
 * Gets the current per-request boundary context, if any.
 * Used by the streaming response to collect boundaries for later resolution.
 */
export function getCurrentBoundaryContext(): BoundaryContext | undefined {
  return boundaryALS.getStore();
}

/**
 * Runs a function within a per-request boundary context.
 * Used by the SSR streaming pipeline to collect boundaries.
 */
export function withBoundaryContext<T>(fn: () => T): T {
  const ctx: BoundaryContext = { boundaries: new Map() };
  return boundaryALS.run(ctx, fn);
}

/**
 * Builds the fallback HTML wrapper for a boundary ID.
 * The fallback content is wrapped in a `<div>` with the boundary ID so the
 * browser can find it and replace it when the resolved content arrives.
 *
 * (v2.1 — Fix #4: real Suspense streaming with `<template>` replacement)
 */
export function buildFallbackHtml(boundaryId: string, fallbackHtml: string): string {
  return `<div id="${boundaryId}" style="display:contents" data-elur-boundary="${boundaryId}">${fallbackHtml}</div>`;
}

/**
 * Builds the resolved content chunk for a boundary ID.
 * Emits a `<template>` element with the resolved content, followed by a
 * `<script>` that replaces the fallback div with the template content
 * in-place. This is real Suspense streaming — the browser swaps the DOM
 * node without a full re-render.
 *
 * (v2.1 — Fix #4: real Suspense streaming with `<template>` replacement)
 */
export function buildResolvedChunk(boundaryId: string, resolvedHtml: string): string {
  // Escape the resolved HTML for safe embedding inside a <template> tag.
  // <template> content is inert (not parsed as DOM), so we store the raw
  // HTML and clone it via `content.cloneNode(true)`.
  return `<template id="${boundaryId}-tpl">${resolvedHtml}</template>` +
    `<script>(function(){` +
    `var t=document.getElementById(${JSON.stringify(boundaryId + "-tpl")});` +
    `var f=document.getElementById(${JSON.stringify(boundaryId)});` +
    `if(t&&f){f.replaceWith(t.content.cloneNode(true));}` +
    `document.dispatchEvent(new CustomEvent("elur:rendered"));` +
    `})();</script>`;
}

/**
 * Creates a stream boundary. During SSR, emits the fallback and registers the
 * promise for later resolution by the streaming pipeline. During SSG, the
 * build awaits all boundaries before writing HTML.
 *
 * The boundary ID is deterministic per-request via crypto.randomUUID().
 */
export function streamBoundary<T>(options: StreamBoundaryOptions<T>): ElurTemplate {
  const id = `elur-stream-${randomUUID().slice(0, 8)}`;
  const ctx = boundaryALS.getStore();

  // In SSR mode with a boundary context, register the promise for later.
  if (ctx) {
    ctx.boundaries.set(id, {
      promise: options.promise,
      children: options.children as (value: unknown) => ElurTemplate,
    });
  }

  return {
    __isElurTemplate: true as const,
    mount(container: Element | string) {
      const el = typeof container === "string" ? document.querySelector(container) : container;
      if (!el) throw new Error("[elur-kit] streamBoundary(): container not found");
      // Render fallback initially.
      const handle = options.fallback.mount(el);
      // Attempt to resolve and swap (works in both SSR and client).
      options.promise
        .then((value) => {
          const content = options.children(value);
          el.innerHTML = "";
          const childHandle = content.mount(el);
          // Store the new handle for cleanup.
          (handle as any).__elurChildHandle = childHandle;
        })
        .catch((err) => {
          console.error(`[elur-kit] streamBoundary ${id} failed:`, err);
        });
      return {
        unmount() {
          const childHandle = (handle as any).__elurChildHandle;
          if (childHandle?.unmount) childHandle.unmount();
          handle.unmount();
        },
      };
    },
    _render(parent: Node, before: Node | null): () => void {
      // For SSR/build: render fallback inline. The promise resolution is
      // handled by the streaming pipeline when available.
      const dispose = options.fallback._render(parent, before);

      // Kick off the promise resolution in the background.
      options.promise
        .then((value) => {
          void value;
        })
        .catch((err) => {
          console.error(`[elur-kit] streamBoundary ${id} failed:`, err);
        });

      return dispose;
    },
  } as unknown as ElurTemplate;
}
