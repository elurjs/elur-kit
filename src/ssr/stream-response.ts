// --- Real streaming with ReadableStream (plan §10) ---
//
// Creates a Web Response with a ReadableStream that:
//   1. Sends the document shell + loading fallback immediately.
//   2. Runs the full page render (loaders included) in the background.
//   3. Appends a resolved-content chunk with a deterministic boundary ID.
//   4. Includes a swap script that replaces the loading boundary in-place.
//   5. Cancels the stream and the background render when the client
//      disconnects (AbortSignal), cleaning up listeners.
//
// Response contract (mirrors what Next.js documents for self-hosted
// streaming): `Content-Type: text/html` is sent early, the body is chunked
// (no `Content-Length`), `X-Accel-Buffering: no` asks reverse proxies like
// nginx not to buffer the stream, and `Cache-Control: no-store` keeps CDNs
// from caching a half-sent dynamic stream. Streamed responses are never
// written to the ISR cache — caching a stream mid-flight is unsound, so
// routes served this way always render live.
//
// For adapters without streaming support, `createBufferedResponse()` provides
// a fallback that buffers the full response and returns it as a single
// Response (no streaming).

import type { ElurTemplate } from "@elurjs/core";
import { renderToString } from "../render/render-to-string.js";
import { documentShell, extractAppBody } from "../build/document-shell.js";
import type { PageRoute } from "../router/route-scanner.js";
import type { BuildConfig } from "../build/build.js";
import { renderPage } from "./render.js";
import { randomUUID } from "node:crypto";
import { buildResolvedChunk } from "../middleware/stream-boundary.js";

export interface StreamResponseOptions {
  route: PageRoute;
  params: Record<string, string | string[]>;
  searchParams: URLSearchParams;
  config: Pick<BuildConfig, "lang" | "clientEntry" | "renderEndpoint" | "router" | "js">;
  actions?: Record<string, string[]>;
  importer?: (path: string) => Promise<unknown>;
  request?: Request;
  /** AbortSignal from the host (client disconnect). */
  signal?: AbortSignal;
}

/** Standard headers for a streamed HTML response. */
const STREAM_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  // Ask reverse proxies (nginx and friends) not to buffer the stream; without
  // this the client receives the whole response at once and streaming is
  // pointless. See https://nextjs.org/docs/app/guides/self-hosting#streaming-and-suspense
  "X-Accel-Buffering": "no",
  // A streamed dynamic page is rendered live per request: intermediaries and
  // browsers must not cache it.
  "Cache-Control": "no-store",
};

/**
 * Mid-stream error notice swapped into the loading boundary when the
 * background render fails after the shell was already sent. Inline styles
 * keep it self-contained (the page's CSS may assume the final layout).
 */
function buildErrorNotice(): string {
  return `<div role="alert" style="margin:2rem auto;max-width:32rem;padding:1rem 1.25rem;border:1px solid #e5484d;border-radius:8px;color:#b3373c;font-family:system-ui,sans-serif">` +
    `<strong style="display:block;margin-bottom:.25rem">No se pudo cargar el contenido.</strong>` +
    `<span>Recarga la página para intentarlo de nuevo.</span></div>`;
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

  // The client already disconnected before we produced anything.
  if (signal?.aborted) {
    return new Response("Client Closed Request", { status: 499 });
  }

  // Load the loading boundary component.
  const loadingMod = (await importer(route.loadingPath)) as { default: () => ElurTemplate };
  const loadingHtml = await renderToString(loadingMod.default);

  // Deterministic boundary ID for the swap.
  const boundaryId = `elur-stream-${randomUUID().slice(0, 8)}`;

  // Build the shell with the loading fallback. Streaming sends the shell
  // before the body is known, so the 0%-JS island scan cannot run here —
  // streamed routes always emit the client entry (they are few and usually
  // interactive anyway). The split router chunk is emitted when configured.
  const routerCfg = config.router;
  const routerEnabled = routerCfg?.enabled !== false;
  const routerEntry =
    routerCfg?.entry && routerEnabled && config.js !== "legacy"
      ? routerCfg.entry
      : undefined;
  const shellHtml = documentShell({
    title: "Loading...",
    lang: config.lang,
    body: `<div id="${boundaryId}">${loadingHtml}</div>`,
    data: { __elur_js_streaming: true, page: route.path },
    actions,
    clientEntry: config.clientEntry,
    routerEntry,
    routerEnabled: routerCfg ? routerEnabled : undefined,
    renderEndpoint: config.renderEndpoint,
  });

  // Create a ReadableStream that sends the shell, then the resolved content.
  let aborted = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      const onAbort = () => {
        aborted = true;
        try {
          controller.close();
        } catch {
          // Already closed/errored — nothing to do.
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      /** Enqueue unless the client went away mid-render. */
      const send = (html: string): void => {
        if (aborted) return;
        controller.enqueue(encoder.encode(html));
      };

      try {
        // Send the shell immediately.
        send(shellHtml);

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
        if (aborted) return;

        // If a loader threw a Response, send a redirect/error script.
        if (result.response) {
          const status = result.response.status;
          const location = result.response.headers.get("Location");
          if (location && (status === 301 || status === 302 || status === 307 || status === 308)) {
            send(`<script>window.location.href=${JSON.stringify(location)};</script>`);
          } else {
            // A non-redirect thrown response (404, 403, ...): swap the loading
            // boundary for an error notice instead of leaving a spinner.
            send(
              buildResolvedChunk(boundaryId, buildErrorNotice()) +
              `<script>console.error(${JSON.stringify(`Loader responded with status ${status}`)});</script>`,
            );
          }
          return;
        }

        // Extract the inner body from the full render. The document shell
        // wraps the page in explicit markers; the regex fallback covers
        // documents assembled without them.
        const innerBody = extractAppBody(result.html)
          ?? result.html.match(/<div id="app">([\s\S]*)<\/div>\s*(<script|$)/)?.[1]?.trim()
          ?? result.html;

        // Send a `<template>` chunk + replacement script that swaps the
        // loading boundary with the real content in-place.
        send(buildResolvedChunk(boundaryId, innerBody));
      } catch (err) {
        // The shell is already on the wire, so the error must arrive as a
        // chunk: swap the loading boundary for an error notice and log the
        // details to the console.
        const errorMsg = err instanceof Error ? err.message : String(err);
        send(
          buildResolvedChunk(boundaryId, buildErrorNotice()) +
          `<script>console.error(${JSON.stringify(errorMsg)});</script>`,
        );
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (!aborted) {
          controller.close();
        }
      }
    },

    cancel() {
      // Client disconnected (the runtime cancelled the stream): mark aborted
      // so a render completing late never enqueues into a dead stream.
      aborted = true;
    },
  });

  return new Response(stream, {
    // No `Content-Length` and no explicit `Transfer-Encoding`: the host
    // runtime (Node, Bun, edge) chunks the body automatically when the
    // length is unknown. Setting Transfer-Encoding by hand produces a
    // duplicated `chunked, chunked` header under Node.
    headers: STREAM_HEADERS,
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
