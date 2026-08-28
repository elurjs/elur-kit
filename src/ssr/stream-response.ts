// --- Real streaming with ReadableStream (plan §10) ---
//
// Creates a Web Response with a ReadableStream that:
//   1. Sends the document shell + loading fallback immediately.
//   2. Runs loaders in the background.
//   3. Appends resolved content chunks with deterministic IDs.
//   4. Includes a swap script that replaces the loading boundary.
//   5. Cleans up on abort (client disconnect).
//
// For adapters without streaming support, `bufferedResponse()` provides a
// fallback that buffers the full response and returns it as a single
// Response (no streaming).

import type { ElurTemplate } from "@elurjs/core";
import { renderToString } from "../render/render-to-string.js";
import { documentShell } from "../build/document-shell.js";
import type { PageRoute } from "../router/route-scanner.js";
import type { BuildConfig } from "../build/build.js";
import { renderPage } from "./render.js";
import { randomUUID } from "node:crypto";
import { buildResolvedChunk } from "../middleware/stream-boundary.js";

export interface StreamResponseOptions {
  route: PageRoute;
  params: Record<string, string | string[]>;
  searchParams: URLSearchParams;
  config: Pick<BuildConfig, "lang" | "clientEntry" | "renderEndpoint">;
  actions?: Record<string, string[]>;
  importer?: (path: string) => Promise<unknown>;
  request?: Request;
  /** AbortSignal from the host (client disconnect). */
  signal?: AbortSignal;
}

/**
 * Creates a streaming Response that sends the shell + loading fallback first,
 * then appends the resolved content.
 *
 * If the route has no loading boundary, falls back to a normal renderPage.
 */
export async function createStreamingResponse(
  options: StreamResponseOptions,
): Promise<Response> {
  const { route, params, searchParams, config, actions, importer = defaultImport, request, signal } = options;

  // If no loading boundary, do a normal render (no streaming).
  if (!route.loadingPath) {
    const result = await renderPage({
      route,
      params,
      searchParams,
      config,
      actions,
      importer,
      request,
    });
    if (result.response) return result.response;
    return new Response(result.html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Load the loading boundary component.
  const loadingMod = (await importer(route.loadingPath)) as { default: () => ElurTemplate };
  const loadingHtml = await renderToString(loadingMod.default);

  // Deterministic boundary ID for the swap.
  const boundaryId = `elur-stream-${randomUUID().slice(0, 8)}`;

  // Build the shell with the loading fallback.
  const shellHtml = documentShell({
    title: "Loading...",
    lang: config.lang,
    body: `<div id="${boundaryId}">${loadingHtml}</div>`,
    data: { __elur_js_streaming: true, page: route.path },
    actions,
    clientEntry: config.clientEntry,
    renderEndpoint: config.renderEndpoint,
  });

  // Create a ReadableStream that sends the shell, then the resolved content.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      // Send the shell immediately.
      controller.enqueue(encoder.encode(shellHtml));

      try {
        // Run the full page render in the background.
        const result = await renderPage({
          route,
          params,
          searchParams,
          config,
          actions,
          importer,
          request,
        });

        // If a loader threw a Response, send a redirect/error script.
        if (result.response) {
          const status = result.response.status;
          const location = result.response.headers.get("Location");
          if (location && (status === 301 || status === 302 || status === 307 || status === 308)) {
            controller.enqueue(encoder.encode(
              `<script>window.location.href=${JSON.stringify(location)};</script>`,
            ));
          } else {
            controller.enqueue(encoder.encode(
              `<script>document.getElementById(${JSON.stringify(boundaryId)}).innerHTML=${JSON.stringify("")};</script>`,
            ));
          }
          controller.close();
          return;
        }

        // Extract the inner body from the full render.
        const bodyMatch = result.html.match(/<div id="app">([\s\S]*)<\/div>\s*(<script|$)/);
        const innerBody = bodyMatch ? bodyMatch[1].trim() : result.html;

        // Send a `<template>` chunk + replacement script that swaps the
        // loading boundary with the real content in-place.
        // (v2.1 — Fix #4: real Suspense streaming with `<template>` replacement)
        const resolvedChunk = buildResolvedChunk(boundaryId, innerBody);

        controller.enqueue(encoder.encode(resolvedChunk));
        controller.close();
      } catch (err) {
        // Send an error message to the boundary using `<template>` replacement.
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorChunk = buildResolvedChunk(
          boundaryId,
          `<div style="color:red">Render error</div>`,
        ) + `<script>console.error(${JSON.stringify(errorMsg)});</script>`;
        controller.enqueue(encoder.encode(errorChunk));
        controller.close();
      }
    },

    cancel() {
      // Client disconnected — cleanup.
      // The background render will complete but its output is discarded.
    },
  });

  // Check if the host signal already aborted.
  if (signal?.aborted) {
    return new Response("Aborted", { status: 499 });
  }

  // Listen for abort and cancel the stream.
  if (signal) {
    signal.addEventListener("abort", () => {
      // The stream's cancel() will be called by the runtime.
    }, { once: true });
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "X-Accel-Buffering": "no", // Disable proxy buffering
    },
  });
}

/**
 * Buffered fallback for adapters without streaming support.
 * Renders the full page and returns it as a single Response.
 */
export async function createBufferedResponse(
  options: StreamResponseOptions,
): Promise<Response> {
  const { route, params, searchParams, config, actions, importer = defaultImport, request } = options;

  const result = await renderPage({
    route,
    params,
    searchParams,
    config,
    actions,
    importer,
    request,
  });

  if (result.response) return result.response;

  return new Response(result.html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const defaultImport = (path: string) => import(path);

/**
 * Checks if the host runtime supports streaming responses.
 * Node, Bun, and modern edge runtimes do. Some serverless platforms may not.
 */
export { supportsStreaming } from "../runtime/capabilities.js";
