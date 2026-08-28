/**
 * Client-side helpers for invoking server actions.
 *
 * Server actions are defined in `page.action.ts` files next to `page.ts`.
 * They export async functions that run on the server. On the client, call them
 * by name using `callAction` or the higher-level `elurJsAction` helper:
 *
 * ```ts
 * import { callAction } from "@elurjs/kit/action";
 *
 * const result = await callAction("submitContact", { name: "Ada" }, { page: "/contact" });
 * ```
 *
 * ```ts
 * import { elurJsAction } from "@elurjs/kit/action";
 *
 * const contact = elurJsAction("submitContact", { page: "/contact" });
 * await contact.submit({ name: "Ada" });
 * console.log(contact.data.value, contact.error.value, contact.pending.value);
 * ```
 */

import { signal } from "@elurjs/core";
import { ActionFailure, RedirectResponse } from "../errors.js";

interface ActionFailurePayload {
  __elur_js_action_failure?: boolean;
  status?: number;
  data?: unknown;
}

interface RedirectPayload {
  __elur_js_action_redirect?: boolean;
  status?: number;
  location?: string;
}

function isActionFailurePayload(value: unknown): value is ActionFailurePayload & { __elur_js_action_failure: true } {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).__elur_js_action_failure === true;
}

function isRedirectPayload(value: unknown): value is RedirectPayload & { __elur_js_action_redirect: true } {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).__elur_js_action_redirect === true;
}

export interface ActionRequest {
  name: string;
  page?: string;
  args: unknown[];
}

export interface CallActionOptions {
  /** Page URL path that scopes the action, e.g. `/contact`. */
  page?: string;
}

/**
 * Call a server action by name.
 *
 * The request is sent as a POST to `/__elur-js/actions` with the action name,
 * optional page scope, and serialized arguments. The server executes the
 * matching exported function from the scanned `page.action.ts` modules and
 * returns its JSON result.
 */
export async function callAction<T = unknown>(
  name: string,
  args: unknown = [],
  options: CallActionOptions = {},
): Promise<T | ActionFailure<T> | RedirectResponse> {
  const argsArray = Array.isArray(args) ? args : [args];
  const res = await fetch("/__elur-js/actions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ name, page: options.page, args: argsArray } as ActionRequest),
  });

  const text = await res.text();
  if (!res.ok) {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      // not JSON, treat as plain error
    }
    if (isActionFailurePayload(payload) && payload.status !== undefined) {
      return new ActionFailure(payload.status, payload.data as T);
    }
    throw new Error(`Action "${name}" failed: ${text}`);
  }

  const payload: unknown = JSON.parse(text);
  if (isRedirectPayload(payload) && payload.status !== undefined && payload.location !== undefined) {
    return new RedirectResponse(payload.status, payload.location);
  }

  return payload as T;
}

export interface ElurJsAction<TInput = unknown, TOutput = unknown> {
  /** Submit the action with the given input. */
  submit(input: TInput): Promise<TOutput | ActionFailure<TOutput> | RedirectResponse>;
  /** Signal that is true while the action is running. */
  pending: { value: boolean };
  /** Signal with the last successful result, action failure, redirect, or null. */
  data: { value: TOutput | ActionFailure<TOutput> | RedirectResponse | null };
  /** Signal with the last error, or null. */
  error: { value: Error | null };
}

/**
 * Create a reactive handle for a server action.
 *
 * Returns a `submit` function and signals for `pending`, `data`, and `error`.
 * Useful for wiring actions to forms and islands without manual signal boilerplate.
 */
export function elurJsAction<TInput = unknown, TOutput = unknown>(
  name: string,
  options: CallActionOptions = {},
): ElurJsAction<TInput, TOutput> {
  const pending = signal(false);
  const error = signal<Error | null>(null);
  const data = signal<TOutput | ActionFailure<TOutput> | RedirectResponse | null>(null);

  async function submit(input: TInput): Promise<TOutput | ActionFailure<TOutput> | RedirectResponse> {
    pending.value = true;
    error.value = null;
    try {
      const result = await callAction<TOutput>(name, input, options);
      data.value = result;
      return result;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      pending.value = false;
    }
  }

  return {
    submit,
    pending,
    data,
    error,
  };
}

// Server-side: defineAction() for typed actions with validation/abort/cache.
export {
  defineAction,
  type DefineActionOptions,
  type DefinedAction,
  type DefinedActionFn,
  type ActionContext,
  type ActionInputValidator,
  type ActionConcurrencyMode,
} from "./define.js";
