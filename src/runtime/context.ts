import type { ResolvedElurConfig } from "../config/index.js";
import { randomUUID } from "node:crypto";

// --- RequestContext: unified per-request runtime context ---
//
// Every runtime path (SSR server, CLI preview/dev, adapters, Vite plugin)
// eventually funnels through a single Web handler that receives a Web Request
// and returns a Web Response. RequestContext carries the resolved config,
// route tables, action registry and request-scoped state so handlers do not
// re-derive this information on every request.
//
// Design goals (runtime-security §4):
//   * One type used by every runtime entry point.
//   * No Node-specific APIs on the type — only Web standards.
//   * Carries per-request state: params, locals, cookies, signal, requestId.
//   * response.headers supports multiple Set-Cookie without collapsing them.
//   * signal aborts when the host disconnects (when the platform allows it).
//   * Middleware/loaders/actions share the same context or readonly views.

export interface RouteTable {
  pages: import("../router/route-scanner.js").PageRoute[];
  api: import("../router/route-scanner.js").ApiRoute[];
  error404?: import("../router/route-scanner.js").PageRoute;
  error500?: import("../router/route-scanner.js").PageRoute;
}

// --- CookieJar: read cookies from request, write to response ---

/** Read-only access to request cookies. */
export interface CookieJar {
  /** Gets a cookie value by name, or undefined if not present. */
  get(name: string): string | undefined;
  /** Returns all cookie name-value pairs. */
  getAll(): Record<string, string>;
  /** Checks if a cookie exists. */
  has(name: string): boolean;
}

/** Write access to response cookies (Set-Cookie headers). */
export interface ResponseCookieJar {
  /** Sets a Set-Cookie header. */
  set(name: string, value: string, options?: CookieOptions): void;
  /** Removes a cookie by setting it expired. */
  clear(name: string, options?: CookieOptions): void;
  /** Returns all Set-Cookie header values accumulated so far. */
  getAll(): string[];
}

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
}

/** Mutable response state accumulated during the request lifecycle. */
export interface ResponseState {
  status?: number;
  headers: Headers;
  cookies: ResponseCookieJar;
}

// --- Cookie implementation ---

class RequestCookieJar implements CookieJar {
  private cookies: Record<string, string>;

  constructor(request: Request) {
    this.cookies = parseCookies(request.headers.get("Cookie") ?? "");
  }

  get(name: string): string | undefined {
    return this.cookies[name];
  }

  getAll(): Record<string, string> {
    return { ...this.cookies };
  }

  has(name: string): boolean {
    return name in this.cookies;
  }
}

class MutableResponseCookieJar implements ResponseCookieJar {
  private entries: string[] = [];

  set(name: string, value: string, options: CookieOptions = {}): void {
    this.entries.push(serializeCookie(name, value, options));
  }

  clear(name: string, options: CookieOptions = {}): void {
    this.entries.push(serializeCookie(name, "", { ...options, maxAge: 0, expires: new Date(0) }));
  }

  getAll(): string[] {
    return [...this.entries];
  }
}

function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    result[name] = value;
  }
  return result;
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${value}`];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  return parts.join("; ");
}

export interface RequestContextOptions {
  request: Request;
  config: ResolvedElurConfig;
  routes: RouteTable;
  actions: import("../action/scan.js").ActionRegistry;
  /** Public action names serialized into the HTML shell. */
  publicActions: Record<string, string[]>;
  /** Optional module loader for adapter-bundled entries. */
  importer?: (path: string) => unknown | Promise<unknown>;
  /** Whether the render endpoint (/__elur-js/render) is available. */
  renderEndpoint?: boolean;
  /** Whether to bypass the ISR cache (dev mode). */
  noCache?: boolean;
  /** ISR cache directory (absolute). */
  cacheDir?: string;
  /** Default ISR revalidate interval in seconds. */
  defaultRevalidate?: number;
  /** Route params (populated after route matching). */
  params?: Record<string, string | string[] | undefined>;
  /** Per-request locals (populated by middleware). */
  locals?: Record<string, unknown>;
  /** Abort signal for the request (from host disconnect). */
  signal?: AbortSignal;
  /** Request ID (auto-generated if not provided). */
  requestId?: string;
  /** Platform-specific context (e.g. Vercel, Netlify). */
  platform?: unknown;
  /** Matched route (populated after route matching). */
  route?: import("../router/route-scanner.js").PageRoute | import("../router/route-scanner.js").ApiRoute;
}

export class RequestContext {
  readonly request: Request;
  readonly url: URL;
  readonly config: ResolvedElurConfig;
  readonly routes: RouteTable;
  readonly actions: import("../action/scan.js").ActionRegistry;
  readonly publicActions: Record<string, string[]>;
  readonly importer?: (path: string) => unknown | Promise<unknown>;
  readonly renderEndpoint: boolean;
  readonly noCache: boolean;
  readonly cacheDir?: string;
  readonly defaultRevalidate?: number;

  // Per-request state (runtime-security §4)
  /** Route params derived from the matched route. */
  params: Readonly<Record<string, string | string[] | undefined>>;
  /** Per-request locals, populated by middleware. Not global. */
  locals: Record<string, unknown>;
  /** Read-only access to request cookies. */
  readonly cookies: CookieJar;
  /** Abort signal (from host disconnect when platform allows). */
  readonly signal: AbortSignal;
  /** Unique request ID for logging/correlation. */
  readonly requestId: string;
  /** Platform-specific context (Vercel, Netlify, etc.). */
  readonly platform: unknown;
  /** Matched route after route matching. */
  route?: import("../router/route-scanner.js").PageRoute | import("../router/route-scanner.js").ApiRoute;
  /** Mutable response state accumulated during the request. */
  readonly response: ResponseState;

  constructor(options: RequestContextOptions) {
    this.request = options.request;
    this.url = new URL(options.request.url);
    this.config = options.config;
    this.routes = options.routes;
    this.actions = options.actions;
    this.publicActions = options.publicActions;
    this.importer = options.importer;
    this.renderEndpoint = options.renderEndpoint ?? true;
    this.noCache = options.noCache ?? false;
    this.cacheDir = options.cacheDir;
    this.defaultRevalidate = options.defaultRevalidate;

    // Per-request state
    this.params = options.params ?? {};
    this.locals = options.locals ?? {};
    this.cookies = new RequestCookieJar(options.request);
    this.signal = options.signal ?? new AbortController().signal;
    this.requestId = options.requestId ?? randomUUID();
    this.platform = options.platform;
    this.route = options.route;
    this.response = {
      status: undefined,
      headers: new Headers(),
      cookies: new MutableResponseCookieJar(),
    };
  }

  /** The pathname without a query string. */
  get pathname(): string {
    return this.url.pathname;
  }

  /** The HTTP method, uppercased. */
  get method(): string {
    return (this.request.method ?? "GET").toUpperCase();
  }

  /** Whether the request accepts JSON. */
  get wantsJson(): boolean {
    return (this.request.headers.get("Accept") ?? "").includes("application/json");
  }

  /** Search params from the request URL. */
  get searchParams(): URLSearchParams {
    return this.url.searchParams;
  }

  /** Render config passed to renderPage/renderErrorPage. */
  get renderConfig(): { lang?: string; clientEntry?: string; renderEndpoint?: boolean } {
    return {
      lang: undefined,
      clientEntry: undefined,
      renderEndpoint: this.renderEndpoint,
    };
  }

  /** Applies accumulated response state (headers, cookies, status) to a Response. */
  applyToResponse(response: Response): Response {
    const headers = new Headers(response.headers);
    // Merge accumulated headers
    for (const [key, value] of this.response.headers.entries()) {
      headers.set(key, value);
    }
    // Append Set-Cookie values (multiple allowed)
    for (const cookie of this.response.cookies.getAll()) {
      headers.append("Set-Cookie", cookie);
    }
    const status = this.response.status ?? response.status;
    return new Response(response.body, {
      status,
      statusText: response.statusText,
      headers,
    });
  }
}

// --- ResponseBuilder: small helpers for consistent Web Responses ---

export function htmlResponse(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers as Record<string, string> },
  });
}

export function jsonResponse(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers as Record<string, string> },
  });
}

export function textResponse(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers as Record<string, string> },
  });
}

export function notFound(body = "Not Found"): Response {
  return textResponse(body, 404);
}

export function methodNotAllowed(method: string): Response {
  return textResponse(`Method not allowed: ${method}`, 405);
}

export function serverError(body: string): Response {
  return textResponse(body, 500);
}

// --- Content-type guessing (shared by all static-serving paths) ---

export function guessContentType(filePath: string): string {
  switch (filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase()) {
    case "html": return "text/html; charset=utf-8";
    case "js": return "application/javascript; charset=utf-8";
    case "mjs": return "application/javascript; charset=utf-8";
    case "css": return "text/css; charset=utf-8";
    case "json": return "application/json; charset=utf-8";
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "avif": return "image/avif";
    case "ico": return "image/x-icon";
    case "woff": return "font/woff";
    case "woff2": return "font/woff2";
    case "wasm": return "application/wasm";
    case "txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

// --- Static file serving as a Web handler (reuses resolveStaticFile) ---

import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveStaticFile } from "./static.js";

/**
 * Serves a static file from the root directory with full conditional and
 * range support:
 *
 * - ETag / Last-Modified with If-None-Match / If-Modified-Since → 304.
 * - `Range` with `If-Range` (ETag or date) → 206 with `Content-Range`.
 * - HEAD → same headers as GET without a body.
 * - Invalid/unsatisfiable ranges → 416 with a `Content-Range: bytes (asterisk)/size` header.
 *
 * Files with content hashes in their names (e.g. `app-abc123.js`) get
 * `Cache-Control: public, max-age=31536000, immutable`.
 *
 * @param root Static file root (absolute path).
 * @param pathname Request pathname.
 * @param request Optional request for conditional/range/HEAD handling.
 */
export async function serveStaticFile(
  root: string,
  pathname: string,
  request?: Request,
): Promise<Response | null> {
  const filePath = await resolveStaticFile(root, pathname);
  if (!filePath) return null;
  try {
    const [data, stats] = await Promise.all([
      readFile(filePath),
      stat(filePath),
    ]);

    const contentType = guessContentType(filePath);
    const etag = `"${createHash("sha1").update(data).digest("hex").slice(0, 16)}"`;
    const lastModified = stats.mtime.toUTCString();
    const isHead = request?.method === "HEAD";
    const size = data.byteLength;

    const baseHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(size),
      ETag: etag,
      "Last-Modified": lastModified,
      "Accept-Ranges": "bytes",
    };

    // Determine Cache-Control: hashed assets get immutable, others get a
    // short revalidation window.
    const baseName = filePath.split("/").pop() ?? "";
    const isHashed = /[a-f0-9]{8,}\.(js|css|woff2?|wasm|png|jpg|jpeg|webp|avif|svg)$/i.test(baseName);
    baseHeaders["Cache-Control"] = isHashed
      ? "public, max-age=31536000, immutable"
      : "public, max-age=0, must-revalidate";

    // Conditional requests (If-None-Match takes precedence).
    const ifNoneMatch = request?.headers.get("If-None-Match");
    if (ifNoneMatch && etagListMatches(ifNoneMatch, etag)) {
      return new Response(null, { status: 304, headers: baseHeaders });
    }
    const ifModifiedSince = request?.headers.get("If-Modified-Since");
    if (ifModifiedSince) {
      const since = Date.parse(ifModifiedSince);
      if (!isNaN(since) && Math.floor(stats.mtime.getTime() / 1000) <= Math.floor(since / 1000)) {
        return new Response(null, { status: 304, headers: baseHeaders });
      }
    }

    // Range support with If-Range validation.
    const rangeHeader = request?.headers.get("Range");
    const ifRange = request?.headers.get("If-Range");
    if (rangeHeader && (!ifRange || ifRangeMatches(ifRange, etag, stats.mtime))) {
      const range = parseRange(rangeHeader, size);
      if (range === null) {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
        });
      }
      if (range) {
        const [start, end] = range;
        const chunk = data.subarray(start, end + 1);
        const headers: Record<string, string> = {
          ...baseHeaders,
          "Content-Length": String(chunk.byteLength),
          "Content-Range": `bytes ${start}-${end}/${size}`,
        };
        if (isHead) return new Response(null, { status: 206, headers });
        return new Response(chunk, { status: 206, headers });
      }
    }

    if (isHead) return new Response(null, { status: 200, headers: baseHeaders });
    return new Response(data, { status: 200, headers: baseHeaders });
  } catch {
    return null;
  }
}

function etagListMatches(ifNoneMatch: string, etag: string): boolean {
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag);
}

function ifRangeMatches(ifRange: string, etag: string, mtime: Date): boolean {
  if (ifRange.startsWith('"') || ifRange.startsWith("W/")) return ifRange === etag;
  const date = Date.parse(ifRange);
  return !isNaN(date) && Math.floor(mtime.getTime() / 1000) <= Math.floor(date / 1000);
}

/**
 * Parses a single `Range: bytes=...` header. Returns:
 * - `[start, end]` for a satisfiable range.
 * - `null` when the header is malformed or unsatisfiable (→ 416).
 * - `undefined` when the header is valid but the whole resource is requested
 *   (e.g. `bytes=0-` for an empty file) — serve the full body.
 */
function parseRange(rangeHeader: string, size: number): [number, number] | null | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const startText = match[1];
  const endText = match[2];

  if (startText === "" && endText === "") return null;
  if (startText === "") {
    // Suffix range: last N bytes.
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const start = Math.max(0, size - suffix);
    if (size === 0) return undefined;
    return [start, size - 1];
  }

  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null;
  const end = endText === "" ? size - 1 : Number(endText);
  if (!Number.isSafeInteger(end) || end < start) return null;
  return [start, Math.min(end, size - 1)];
}
