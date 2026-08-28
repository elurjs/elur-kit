import type { ActionRequest } from "./index.js";
import { isActionFailure, isRedirectResponse, publicErrorResponse } from "../errors.js";
import { verifyOrigin, originForbidden, type OriginCheckOptions } from "./origin.js";
import {
  encodeActionErrorCookie,
  setActionErrorCookieHeader,
} from "./error-store.js";

/**
 * Resolves a server action by name and optional page scope.
 */
export type ActionResolver = (
  name: string,
  page?: string,
) => Promise<((...args: unknown[]) => unknown) | undefined>;

/** Options shared by `handleActionRequest` callers for CSRF protection. */
export interface ActionSecurityOptions extends OriginCheckOptions {
  /** Maximum body size in bytes. Defaults to 1MB (1_048_576). */
  bodyLimit?: number;
}

/** Default body size limit: 1MB. */
const DEFAULT_BODY_LIMIT = 1_048_576;

/**
 * Reads the request body as text, enforcing a maximum size.
 * Returns a 413 response if the body exceeds the limit.
 */
async function readBodyWithLimit(
  request: Request,
  limit: number,
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && parseInt(contentLength, 10) > limit) {
    return {
      ok: false,
      response: new Response("Request body too large", {
        status: 413,
        headers: { "Content-Type": "text/plain" },
      }),
    };
  }
  // Read the body as a stream with a size cap to prevent memory exhaustion
  // from chunked transfer encoding without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: true, text: "" };
  }
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  try {
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > limit) {
        try { reader.cancel(); } catch { /* ignore */ }
        return {
          ok: false,
          response: new Response("Request body too large", {
            status: 413,
            headers: { "Content-Type": "text/plain" },
          }),
        };
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  const total = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    total.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(total) };
}

function parseFormBody(body: string): Record<string, unknown> {
  const params = new URLSearchParams(body);
  const result: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (result[key] === undefined) {
      result[key] = value;
    } else if (Array.isArray(result[key])) {
      (result[key] as unknown[]).push(value);
    } else {
      result[key] = [result[key], value];
    }
  }
  return result;
}

async function parseActionRequest(
  request: Request,
  bodyLimit: number = DEFAULT_BODY_LIMIT,
): Promise<
  | { ok: true; name: string; page?: string; args: unknown[]; wantsJson: boolean }
  | { ok: false; response: Response }
> {
  if (request.method !== "POST") {
    return {
      ok: false,
      response: new Response("Method not allowed", {
        status: 405,
        headers: { "Content-Type": "text/plain" },
      }),
    };
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  const wantsJson = (request.headers.get("Accept") ?? "").includes("application/json");

  let name: string | undefined;
  let page: string | undefined;
  let args: unknown[] = [];

  if (contentType.includes("application/json")) {
    const bodyResult = await readBodyWithLimit(request, bodyLimit);
    if (!bodyResult.ok) return { ok: false, response: bodyResult.response };
    let body: ActionRequest;
    try {
      body = JSON.parse(bodyResult.text) as ActionRequest;
    } catch {
      return {
        ok: false,
        response: new Response("Invalid JSON body", {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        }),
      };
    }
    name = body.name;
    page = body.page;
    args = Array.isArray(body.args) ? body.args : [];
  } else if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    // For multipart, use the native formData() parser after checking
    // Content-Length against the limit. For urlencoded, use our size-capped
    // reader to handle chunked encoding without Content-Length.
    if (contentType.includes("multipart/form-data")) {
      const contentLength = request.headers.get("Content-Length");
      if (contentLength && parseInt(contentLength, 10) > bodyLimit) {
        return {
          ok: false,
          response: new Response("Request body too large", {
            status: 413,
            headers: { "Content-Type": "text/plain" },
          }),
        };
      }
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return {
          ok: false,
          response: new Response("Invalid form body", {
            status: 400,
            headers: { "Content-Type": "text/plain" },
          }),
        };
      }
      name = form.get("__elur_js_action_name") as string | null ?? undefined;
      page = form.get("__elur_js_action_page") as string | null ?? undefined;
      const input: Record<string, unknown> = {};
      for (const [key, value] of form) {
        if (key === "__elur_js_action_name" || key === "__elur_js_action_page") continue;
        input[key] = value;
      }
      args = [input];
    } else {
      const bodyResult = await readBodyWithLimit(request, bodyLimit);
      if (!bodyResult.ok) return { ok: false, response: bodyResult.response };
      const form = parseFormBody(bodyResult.text);
      name = form.__elur_js_action_name as string | undefined;
      page = form.__elur_js_action_page as string | undefined;
      const input: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(form)) {
        if (key === "__elur_js_action_name" || key === "__elur_js_action_page") continue;
        input[key] = value;
      }
      args = [input];
    }
  } else {
    // Try to parse a plain form body as a fallback for progressive enhancement.
    const bodyResult = await readBodyWithLimit(request, bodyLimit);
    if (!bodyResult.ok) return { ok: false, response: bodyResult.response };
    const form = parseFormBody(bodyResult.text);
    name = form.__elur_js_action_name as string | undefined;
    page = form.__elur_js_action_page as string | undefined;
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(form)) {
      if (key === "__elur_js_action_name" || key === "__elur_js_action_page") continue;
      input[key] = value;
    }
    args = [input];
  }

  if (!name || typeof name !== "string") {
    return {
      ok: false,
      response: new Response("Missing action name", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      }),
    };
  }

  return { ok: true, name, page, args, wantsJson };
}

/**
 * Handles a POST request to the server action endpoint.
 *
 * Accepts both JSON requests (`{ name, page?, args }`) and HTML form submissions
 * for progressive enhancement. The provided resolver looks up the action
 * implementation, invokes it with the supplied arguments and returns the result
 * as JSON or redirects back to the request origin for form submissions.
 *
 * Origin verification (CSRF protection) runs before parsing the body: any
 * cross-origin POST is rejected with 403 unless its origin is allow-listed via
 * `security.allowedOrigins`.
 *
 * For progressive-enhancement form submissions that fail, the failure payload
 * is relayed back via a short-lived `__elur_js_action_error` cookie (SameSite=Lax,
 * Max-Age=15s) instead of a query param, so errors do not leak into browser
 * history, server logs or third-party Referer headers.
 */
export async function handleActionRequest(
  request: Request,
  resolveAction: ActionResolver,
  security: ActionSecurityOptions = {},
): Promise<Response> {
  // CSRF: verify same-origin (or allow-listed) before doing any work.
  const originError = verifyOrigin(request, security);
  if (originError) return originForbidden(originError);

  const parsed = await parseActionRequest(request, security.bodyLimit ?? DEFAULT_BODY_LIMIT);
  if (!parsed.ok) return parsed.response;

  const { name, page, args, wantsJson } = parsed;

  try {
    const action = await resolveAction(name, page);
    if (!action) {
      const message = page ? `Action not found: ${name} (page: ${page})` : `Action not found: ${name}`;
      return new Response(message, {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const result = await action(...args);

    if (isActionFailure(result)) {
      if (wantsJson) {
        return new Response(JSON.stringify({ __elur_js_action_failure: true, status: result.status, data: result.data }), {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Progressive enhancement: redirect back with the failure in a cookie.
      const referer = request.headers.get("Referer") ?? "/";
      const url = new URL(referer, "http://localhost");
      const { value } = encodeActionErrorCookie(result.data, result.status);
      return new Response(null, {
        status: 303,
        headers: {
          Location: url.pathname + url.search,
          "Content-Type": "text/plain",
          "Set-Cookie": setActionErrorCookieHeader(value),
        },
      });
    }

    if (isRedirectResponse(result)) {
      if (wantsJson) {
        return new Response(
          JSON.stringify({ __elur_js_action_redirect: true, status: result.status, location: result.location }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(null, {
        status: result.status,
        headers: { Location: result.location, "Content-Type": "text/plain" },
      });
    }

    if (wantsJson) {
      return new Response(JSON.stringify(result ?? null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // For progressive enhancement (plain form POST), redirect back.
    const referer = request.headers.get("Referer") ?? "/";
    return new Response(null, {
      status: 303,
      headers: {
        Location: typeof result === "string" ? result : referer,
        "Content-Type": "text/plain",
      },
    });
  } catch (err) {
    console.error("[elur-kit] Action error:", err);
    return publicErrorResponse(err, { includeDetail: false });
  }
}

export { verifyOrigin, originForbidden, type OriginCheckOptions } from "./origin.js";
export {
  decodeActionErrorCookie,
  clearActionErrorCookieHeader,
  setActionErrorCookieHeader,
  ACTION_ERROR_COOKIE,
} from "./error-store.js";
