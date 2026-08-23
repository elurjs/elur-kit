// --- Cache policy per route (runtime-security §9.1) ---
//
// Authors can declare a cache policy in their page.data.ts:
//
//   export const cache = {
//     mode: "public",        // "public" | "private" | "dynamic"
//     revalidate: 60,        // seconds
//     tags: ["products"],    // for tag-based invalidation
//   };
//
// Default policy: "dynamic" (no public ISR caching).
// Requests with Cookie/Authorization are never cached publicly.
// Responses with Set-Cookie/private/no-store are never cached publicly.

/** Cache mode for a route. */
export type CacheMode = "public" | "private" | "dynamic";

/** Cache policy declared by the route's data module. */
export interface CachePolicy {
  mode: CacheMode;
  revalidate: number;
  tags?: string[];
}

/** Default cache policy when none is declared. */
export const DEFAULT_CACHE_POLICY: CachePolicy = {
  mode: "dynamic",
  revalidate: 0,
};

/**
 * Normalizes a raw cache export from a data module into a CachePolicy.
 * Returns the default policy if the input is invalid or missing.
 */
export function normalizeCachePolicy(raw: unknown): CachePolicy {
  if (!raw || typeof raw !== "object") return DEFAULT_CACHE_POLICY;
  const obj = raw as Record<string, unknown>;
  const mode = obj.mode;
  if (mode !== "public" && mode !== "private" && mode !== "dynamic") {
    return DEFAULT_CACHE_POLICY;
  }
  const revalidate = typeof obj.revalidate === "number" ? obj.revalidate : 0;
  const tags = Array.isArray(obj.tags) ? obj.tags.filter((t) => typeof t === "string") : undefined;
  return { mode, revalidate, tags };
}

/**
 * Determines whether a route's cache policy allows public caching for the
 * given request.
 *
 * Per §9.1:
 * - "dynamic" → never cache
 * - "private" → never cache publicly (requires private adapter)
 * - "public" → cache only if request has no Cookie/Authorization
 */
export function shouldCachePublic(
  policy: CachePolicy,
  request: Request,
): boolean {
  if (policy.mode !== "public") return false;
  if (policy.revalidate <= 0) return false;
  if (request.headers.get("Cookie")) return false;
  if (request.headers.get("Authorization")) return false;
  return true;
}
