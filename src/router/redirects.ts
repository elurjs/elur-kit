// --- Redirects, rewrites, and route headers (plan §11.1, §10) ---
//
// Authors can declare redirects and rewrites in their config:
//
//   export default defineConfig({
//     redirects: [
//       { from: "/old-blog/:slug", to: "/blog/:slug", status: 301 },
//     ],
//     rewrites: [
//       { from: "/api/legacy/*", to: "/api/v2/*" },
//     ],
//     headers: [
//       { path: "/admin/*", headers: { "X-Robots-Tag": "noindex" } },
//     ],
//   });
//
// Redirects return a Response with the appropriate status and Location.
// Rewrites change the pathname before routing (transparent to the user).
// Route headers are applied to the response for matching paths.

export interface RedirectRule {
  /** Source path pattern (supports :param and *). */
  from: string;
  /** Destination path (supports :param interpolation). */
  to: string;
  /** HTTP status code (301, 302, 307, 308). Default: 308. */
  status?: 301 | 302 | 307 | 308;
}

export interface RewriteRule {
  /** Source path pattern (supports :param and *). */
  from: string;
  /** Destination path (supports :param interpolation). */
  to: string;
}

export interface RouteHeadersRule {
  /** Path pattern to match (supports :param and *). */
  path: string;
  /** Headers to apply to matching responses. */
  headers: Record<string, string>;
}

/**
 * Checks if a pathname matches a redirect rule and returns the redirect
 * Response if so.
 */
export function matchRedirect(
  pathname: string,
  rules: RedirectRule[],
): Response | undefined {
  for (const rule of rules) {
    const params = matchPattern(pathname, rule.from);
    if (params) {
      const location = interpolatePath(rule.to, params);
      const status = rule.status ?? 308;
      return new Response(null, {
        status,
        headers: { Location: location },
      });
    }
  }
  return undefined;
}

/**
 * Checks if a pathname matches a rewrite rule and returns the rewritten
 * pathname if so.
 */
export function matchRewrite(
  pathname: string,
  rules: RewriteRule[],
): string | undefined {
  for (const rule of rules) {
    const params = matchPattern(pathname, rule.from);
    if (params) {
      return interpolatePath(rule.to, params);
    }
  }
  return undefined;
}

/**
 * Returns headers that should be applied to a response for the given pathname.
 */
export function matchRouteHeaders(
  pathname: string,
  rules: RouteHeadersRule[],
): Record<string, string> | undefined {
  for (const rule of rules) {
    if (matchPattern(pathname, rule.path)) {
      return rule.headers;
    }
  }
  return undefined;
}

/**
 * Matches a pathname against a pattern with :param and * wildcards.
 * Returns the extracted params, or undefined if no match.
 */
function matchPattern(pathname: string, pattern: string): Record<string, string> | undefined {
  const cleanPath = pathname.split("?")[0];
  const requestSegments = cleanPath.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);
  const params: Record<string, string> = {};

  let i = 0;
  for (let r = 0; r < patternSegments.length; r++) {
    const seg = patternSegments[r];

    if (seg === "*") {
      // Wildcard matches everything remaining.
      return params;
    }

    if (seg.endsWith("*")) {
      // Catch-all: :name* matches the rest as a single string.
      const name = seg.slice(1, -1);
      const rest = requestSegments.slice(i).join("/");
      params[name] = rest;
      return params;
    }

    if (seg.startsWith(":")) {
      const name = seg.slice(1);
      if (requestSegments[i] === undefined) return undefined;
      params[name] = requestSegments[i];
      i++;
      continue;
    }

    if (seg !== requestSegments[i]) return undefined;
    i++;
  }

  if (i !== requestSegments.length) return undefined;
  return params;
}

/**
 * Interpolates :param placeholders in a path with actual values.
 */
function interpolatePath(template: string, params: Record<string, string>): string {
  return template.replace(/:(\w+)\*?/g, (_match, name: string) => {
    return params[name] ?? "";
  });
}
