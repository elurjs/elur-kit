// --- Security response headers (runtime-security §14) ---
//
// Applies configurable security headers to responses. Defaults are safe and
// compatible: X-Content-Type-Options, Referrer-Policy, frame-ancestors.
// HSTS is only applied under HTTPS or when explicitly configured.
// CSP supports a "nonce" placeholder replaced per-request.
// User-set headers on the response are never overwritten without explicit
// merge rules.

import type { SecurityHeadersConfig } from "../config/index.js";

/** Default security headers applied when `security.headers` is not `false`. */
export const DEFAULT_SECURITY_HEADERS: Required<
  Omit<SecurityHeadersConfig, "contentSecurityPolicy" | "hsts" | "permissionsPolicy">
> = {
  noSniff: true,
  referrerPolicy: "strict-origin-when-cross-origin",
  frameAncestors: "SAMEORIGIN",
};

/**
 * Builds the security headers map from the resolved config.
 * Returns an empty map if headers are disabled.
 */
export function buildSecurityHeaders(
  config: SecurityHeadersConfig | false,
  isHttps: boolean,
  nonce?: string,
): Record<string, string> {
  if (config === false) return {};

  const headers: Record<string, string> = {};
  const merged = { ...DEFAULT_SECURITY_HEADERS, ...config };

  if (merged.noSniff) {
    headers["X-Content-Type-Options"] = "nosniff";
  }

  if (merged.referrerPolicy) {
    headers["Referrer-Policy"] = merged.referrerPolicy;
  }

  // Frame policy: prefer CSP frame-ancestors if CSP is set, otherwise
  // X-Frame-Options for broader compatibility.
  if (merged.contentSecurityPolicy) {
    let csp = merged.contentSecurityPolicy;
    if (nonce) {
      csp = csp.replace(/\bnonce\b/g, `'nonce-${nonce}'`);
    }
    headers["Content-Security-Policy"] = csp;
  } else if (merged.frameAncestors) {
    // Without CSP, use X-Frame-Options for frame protection.
    const fa = merged.frameAncestors;
    if (fa === "NONE") {
      headers["X-Frame-Options"] = "DENY";
    } else if (fa === "SAMEORIGIN") {
      headers["X-Frame-Options"] = "SAMEORIGIN";
    } else {
      headers["X-Frame-Options"] = fa;
    }
  }

  // HSTS: only under HTTPS or when explicitly set as a string.
  if (merged.hsts === true && isHttps) {
    headers["Strict-Transport-Security"] = "max-age=15552000; includeSubDomains";
  } else if (typeof merged.hsts === "string") {
    headers["Strict-Transport-Security"] = merged.hsts;
  }

  if (merged.permissionsPolicy) {
    headers["Permissions-Policy"] = merged.permissionsPolicy;
  }

  return headers;
}

/**
 * Applies security headers to an existing Response, preserving any
 * user-set headers unless overridden by security config.
 */
export function applySecurityHeaders(
  response: Response,
  headers: Record<string, string>,
): Response {
  if (Object.keys(headers).length === 0) return response;

  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) {
    // Don't overwrite a header the response already set explicitly.
    if (!newHeaders.has(key)) {
      newHeaders.set(key, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
