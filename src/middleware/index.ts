// --- Middleware ---
//
// Convention: `src/middleware.ts` in the project root exports a default
// function and an optional `config` with a `matcher` array.
//
//   import type { Middleware } from "@elurjs/kit";
//
//   export default function middleware(request: Request) {
//     if (!request.headers.get("Cookie")?.includes("session=")) {
//       return Response.redirect(new URL("/login", request.url), 307);
//     }
//   }
//
//   export const config = { matcher: ["/dashboard/:path*", "/admin/:path*"] };
//
// The middleware runs before routing. Return a `Response` to short-circuit
// (redirect, rewrite, 401, etc.). Return `undefined` or nothing to continue.
// Use `next()` to pass headers to the loader.

import { matchRoute } from "../ssr/match.js";
import type { PageRoute } from "../router/route-scanner.js";

/** The middleware function signature. */
export type Middleware = (request: Request, context: MiddlewareContext) =>
  | Response
  | void
  | Promise<Response | void>;

/** Context passed to the middleware function. */
export interface MiddlewareContext {
  /** Helper to continue to the next handler. Can attach headers, params, and locals. */
  next(options?: {
    headers?: Record<string, string>;
    params?: Record<string, string | string[]>;
    locals?: Record<string, unknown>;
  }): void;
  /** Matched route params (only available if the path matches a page route). */
  params?: Record<string, string | string[]>;
  /** Per-request locals (populated by middleware, available to loaders/actions). */
  locals?: Record<string, unknown>;
}

/** Configuration for the middleware module. */
export interface MiddlewareConfig {
  /** Path patterns that trigger the middleware. Supports `:param` and `:param*`. */
  matcher?: string[];
}

export interface LoadedMiddleware {
  handler: Middleware;
  config: MiddlewareConfig;
}

/** Result of running middleware: either a response to short-circuit with, or continue. */
export type MiddlewareResult =
  | { kind: "response"; response: Response }
  | {
    kind: "continue";
    headers?: Record<string, string>;
    params?: Record<string, string | string[]>;
    locals?: Record<string, unknown>;
  };

/**
 * Loads the user's `src/middleware.ts` module. Returns `null` if no middleware
 * file exists. Distinguishes "file not found" from "file has errors" (§6):
 * an import error is not silently treated as "no middleware".
 */
export async function loadMiddleware(root: string): Promise<LoadedMiddleware | null> {
  const candidates = [
    `${root}/src/middleware.ts`,
    `${root}/middleware.ts`,
  ];

  for (const path of candidates) {
    try {
      const mod = await import(path);
      const handler = (mod.default ?? mod.middleware) as Middleware | undefined;
      if (typeof handler !== "function") continue;
      const config = (mod.config ?? {}) as MiddlewareConfig;
      return { handler, config };
    } catch (err) {
      // Distinguish "module not found" from actual errors.
      // If the error is a module resolution error for this specific file,
      // it means the file doesn't exist — try the next candidate.
      // If it's a syntax/runtime error, rethrow so the user sees it.
      // Note: Bun's ResolveMessage is not `instanceof Error`, so match on the
      // message property instead of relying on the class hierarchy.
      const msg =
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
      if (
        msg.includes("Cannot find module") ||
        msg.includes("Cannot find package") ||
        msg.includes("ENOENT") ||
        msg.includes("Module not found")
      ) {
        // File doesn't exist — try next candidate.
        continue;
      }
      // Actual error in the middleware file — rethrow (§6).
      throw new Error(`[elur-kit] Error loading middleware: ${msg}`, { cause: err });
    }
  }

  return null;
}

/**
 * Checks if a pathname matches any of the middleware's matcher patterns.
 * If no matcher is configured, the middleware runs for every request.
 *
 * Catch-all patterns (`:param*`) match both the base path and any sub-paths,
 * e.g. `/dashboard/:path*` matches `/dashboard` and `/dashboard/settings/users`.
 */
export function matchesMiddleware(pathname: string, config: MiddlewareConfig): boolean {
  if (!config.matcher || config.matcher.length === 0) return true;

  const cleanPath = pathname.split("?")[0];

  for (const pattern of config.matcher) {
    // Exact match.
    if (pattern === cleanPath) return true;

    // Check for catch-all: `/foo/:bar*` should also match `/foo`.
    const catchAllMatch = pattern.match(/^(.*)\/:[\w]+\*$/);
    if (catchAllMatch) {
      const base = catchAllMatch[1];
      if (cleanPath === base) return true;
    }

    // Use matchRoute for param matching.
    const pseudoRoutes: PageRoute[] = [{
      path: pattern,
      pagePath: "",
      params: [],
      layouts: [],
    }];
    if (matchRoute(cleanPath, pseudoRoutes)) return true;
  }

  return false;
}

/**
 * Runs the middleware for a request. Returns the result indicating whether to
 * short-circuit with a response or continue with propagated headers/params/locals.
 *
 * Per §6: cleanup runs in `finally`, response short-circuits the pipeline,
 * headers/params/locals are propagated to downstream handlers.
 */
export async function runMiddleware(
  middleware: LoadedMiddleware,
  request: Request,
  params?: Record<string, string | string[]>,
): Promise<MiddlewareResult> {
  let nextHeaders: Record<string, string> | undefined;
  let nextParams: Record<string, string | string[]> | undefined;
  let nextLocals: Record<string, unknown> | undefined;
  const cleanups: Array<() => void | Promise<void>> = [];

  const context: MiddlewareContext = {
    next(options) {
      if (options?.headers) nextHeaders = options.headers;
      if (options?.params) nextParams = options.params;
      if (options?.locals) nextLocals = options.locals;
    },
    params,
    locals: {},
  };

  try {
    const result = await middleware.handler(request, context);

    if (result instanceof Response) {
      return { kind: "response", response: result };
    }

    return {
      kind: "continue",
      headers: nextHeaders,
      params: nextParams ?? params,
      locals: nextLocals,
    };
  } finally {
    // Run any cleanup functions (§6). Errors in cleanup are logged but
    // do not propagate to the caller.
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (err) {
        console.error("[elur-kit] middleware cleanup error:", err);
      }
    }
  }
}
