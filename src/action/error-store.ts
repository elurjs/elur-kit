// --- Ephemeral action error store ---
//
// Action failures submitted via plain HTML forms (progressive enhancement)
// need to be relayed back to the page so the user sees validation errors.
//
// Previously the failure data was serialized into a `?__nix_js_action_error=`
// query param on the redirect. That leaks errors into browser history,
// server logs and third-party Referer headers.
//
// Now we stash the failure in a short-lived in-memory store keyed by a random
// id, set a small cookie `__nix_js_action_error=<id>` (Max-Age=15s, SameSite=Lax),
// and the next render reads the cookie, fetches the payload, exposes it as
// `props.form`, and clears the entry.
//
// The store is process-local, which is fine for the single-process SSR server
// and the dev server. For multi-instance deployments the cookie carries the
// payload directly when it fits (see `encodeActionErrorCookie`); the store is
// only the overflow path for large payloads.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "__nix_js_action_error";
const MAX_COOKIE_SIZE = 3500; // bytes; leaves headroom under the 4KB cookie limit
const TTL_MS = 15_000;

// HMAC key for signing action error cookies. In production this should be
// set via NIX_JS_ACTION_SECRET env var; otherwise we derive a per-process
// key (sufficient for single-process dev/preview, but NOT for multi-instance).
const ACTION_SECRET =
  process.env.NIX_JS_ACTION_SECRET ?? randomBytes(32).toString("hex");

interface StoredError {
  data: unknown;
  status: number;
  expiresAt: number;
}

const store = new Map<string, StoredError>();

// Periodically purge expired entries so the map does not grow unbounded.
let sweepScheduled = false;
function scheduleSweep(): void {
  if (sweepScheduled) return;
  sweepScheduled = true;
  setTimeout(() => {
    sweepScheduled = false;
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) store.delete(key);
    }
  }, TTL_MS).unref?.();
}

/**
 * Signs a payload with HMAC-SHA256 using the action secret.
 * Returns `signature.payload` (both hex/base64url).
 */
function sign(payload: string): string {
  const sig = createHmac("sha256", ACTION_SECRET).update(payload).digest("hex");
  return `${sig}.${payload}`;
}

/**
 * Verifies a signed value and returns the payload if valid, or undefined.
 * Uses timingSafeEqual to prevent timing attacks.
 */
function verify(value: string): string | undefined {
  const dotIndex = value.indexOf(".");
  if (dotIndex === -1) return undefined;
  const sig = value.slice(0, dotIndex);
  const payload = value.slice(dotIndex + 1);
  const expectedSig = createHmac("sha256", ACTION_SECRET).update(payload).digest("hex");
  if (sig.length !== expectedSig.length) return undefined;
  try {
    if (timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
      return payload;
    }
  } catch {
    // Length mismatch — invalid.
  }
  return undefined;
}

/**
 * Encodes an action failure for the redirect cookie. When the payload fits
 * inside the cookie limit, it is embedded directly as a signed base64url JSON
 * value. When it is too large, it is stored in memory and only a short signed
 * id is written to the cookie.
 *
 * The cookie is signed with HMAC-SHA256 to prevent forgery (A-20).
 *
 * @returns The cookie value to set on the redirect response.
 */
export function encodeActionErrorCookie(
  data: unknown,
  status: number,
): { value: string; storeId?: string } {
  const payload = JSON.stringify({ d: data, s: status });
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  const signed = sign(encoded);
  if (signed.length <= MAX_COOKIE_SIZE) {
    return { value: signed };
  }

  // Overflow: stash in memory and reference by signed id.
  const id = randomBytes(12).toString("hex");
  store.set(id, { data, status, expiresAt: Date.now() + TTL_MS });
  scheduleSweep();
  return { value: sign(`id:${id}`), storeId: id };
}

/**
 * Decodes a cookie value (previously produced by `encodeActionErrorCookie`)
 * into the failure payload. Verifies the HMAC signature first, then resolves
 * in-memory overflow entries and deletes them after reading.
 */
export function decodeActionErrorCookie(value: string | undefined | null):
  | { data: unknown; status: number }
  | undefined {
  if (!value) return undefined;

  // Verify signature first.
  const verifiedPayload = verify(value);
  if (verifiedPayload === undefined) return undefined;

  // Check if it's an in-memory store reference.
  if (verifiedPayload.startsWith("id:")) {
    const id = verifiedPayload.slice(3);
    const entry = store.get(id);
    if (!entry) return undefined;
    store.delete(id);
    if (entry.expiresAt <= Date.now()) return undefined;
    return { data: entry.data, status: entry.status };
  }

  try {
    const json = Buffer.from(verifiedPayload, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { d: unknown; s: number };
    return { data: parsed.d, status: parsed.s };
  } catch {
    return undefined;
  }
}

/** Name of the cookie used to relay action errors. */
export const ACTION_ERROR_COOKIE = COOKIE_NAME;

/** Builds the Set-Cookie header value that clears the error cookie. */
export function clearActionErrorCookieHeader(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/** Builds the Set-Cookie header value that sets the error cookie. */
export function setActionErrorCookieHeader(value: string): string {
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=15; SameSite=Lax; HttpOnly`;
}
