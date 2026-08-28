/**
 * Represents a failed action result. Returned by `fail()` from server actions.
 *
 * The `__elur_js_action_failure` marker is set on the instance so the server can
 * detect it even when the value crosses a bundling boundary (e.g. the CLI is
 * bundled separately from the user's action modules).
 */
export class ActionFailure<TData = unknown> {
  readonly __elur_js_action_failure = true;
  constructor(
    public status: number,
    public data: TData,
  ) {}
}

/**
 * Represents a redirect returned by a server action. Returned by `redirect()`.
 */
export class RedirectResponse {
  readonly __elur_js_action_redirect = true;
  constructor(
    public status: number,
    public location: string,
  ) {}
}

/**
 * Helper to return a validation/error response from a server action.
 *
 * Both argument orders are accepted:
 *
 * ```ts
 * return fail(400, { email: "Invalid email" });
 * return fail({ email: "Invalid email" }, 400);
 * return fail({ email: "Invalid email" }); // defaults to status 400
 * ```
 */
export function fail<TData>(
  statusOrData: number | TData,
  dataOrStatus?: TData | number,
): ActionFailure<unknown> {
  if (typeof statusOrData === "number") {
    return new ActionFailure(statusOrData, dataOrStatus as TData);
  }
  return new ActionFailure((dataOrStatus as number) ?? 400, statusOrData);
}

/**
 * Helper to return a redirect from a server action.
 *
 * Both argument orders are accepted:
 *
 * ```ts
 * return redirect(303, "/login");
 * return redirect("/login"); // defaults to status 303
 * ```
 */
export function redirect(
  statusOrLocation: number | string,
  locationOrStatus?: string | number,
): RedirectResponse {
  if (typeof statusOrLocation === "number") {
    return new RedirectResponse(statusOrLocation, locationOrStatus as string);
  }
  return new RedirectResponse((locationOrStatus as number) ?? 303, statusOrLocation);
}

/**
 * Type guard for action failures. Uses the marker field so it works across
 * bundling boundaries where `instanceof` fails.
 */
export function isActionFailure(value: unknown): value is ActionFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __elur_js_action_failure?: unknown }).__elur_js_action_failure === true
  );
}

/**
 * Type guard for redirects. Uses the marker field so it works across bundling
 * boundaries where `instanceof` fails.
 */
export function isRedirectResponse(value: unknown): value is RedirectResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __elur_js_action_redirect?: unknown }).__elur_js_action_redirect === true
  );
}

// --- Public error sanitization (production-safe 500 responses) ---

/**
 * A stable, publicly safe error description. Never includes stacks, internal
 * paths or messages that could leak secrets or filesystem details.
 */
export interface PublicErrorInfo {
  /** Stable machine-readable code for the response body. */
  code: string;
  /** Stable public message. In non-production this may include the raw message. */
  message: string;
  status: number;
}

/**
 * Maps an arbitrary thrown value to a public-safe error info. By default the
 * public message is generic; `includeDetail` (dev/verbose mode) appends the
 * original `Error.message` for local debugging.
 */
export function toPublicErrorInfo(error: unknown, options: { includeDetail?: boolean } = {}): PublicErrorInfo {
  const code = "INTERNAL_SERVER_ERROR";
  const status = 500;
  if (options.includeDetail && error instanceof Error && error.message) {
    return { code, status, message: error.message };
  }
  return { code, status, message: "Internal Server Error" };
}

/**
 * Builds a production-safe JSON error Response. Logs the raw error separately
 * (never reflected in the response body) and keeps the request id header.
 */
export function publicErrorResponse(
  error: unknown,
  options: { includeDetail?: boolean; requestId?: string } = {},
): Response {
  const info = toPublicErrorInfo(error, options);
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (options.requestId) headers["X-Request-Id"] = options.requestId;
  return new Response(JSON.stringify({ error: info }), {
    status: info.status,
    headers,
  });
}

/** True when the error should be re-thrown as control flow instead of a 500. */
export function isFirstClassResponse(error: unknown): error is Response {
  return typeof Response !== "undefined" && error instanceof Response;
}
