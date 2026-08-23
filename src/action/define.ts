// --- defineAction(): typed server action definition (plan §9.2) ---
//
// Provides a typed wrapper for server actions with:
// - optional input schema validation (without requiring Zod)
// - AbortSignal propagation from the request
// - idempotency key support
// - concurrency modes (latest, queue, parallel)
//
// Legacy exported async functions continue to work: `defineAction()` is an
// opt-in upgrade path, not a replacement.

import type { ActionFailure } from "../errors.js";

// Capture AbortController at module load time — tests may temporarily remove
// it from the global scope.
const AbortControllerCtor = globalThis.AbortController;

/** Concurrency mode for actions called multiple times in rapid succession. */
export type ActionConcurrencyMode = "latest" | "queue" | "parallel";

/** Options for defining a typed server action. */
export interface DefineActionOptions<TInput> {
  /**
   * Optional input validator. Can be a Zod schema, a plain function, or any
   * object with a `.parse()` method. If validation fails, the action returns
   * a 400 ActionFailure with the validation error.
   */
  input?: ActionInputValidator<TInput>;
  /** Concurrency mode when the same action is called multiple times. */
  concurrency?: ActionConcurrencyMode;
  /** Whether the action is idempotent (safe to retry). */
  idempotent?: boolean;
  /** Tags to invalidate from the cache after a successful action (§9.4). */
  invalidateTags?: string[];
  /** Paths to invalidate from the cache after a successful action (§9.4). */
  invalidatePaths?: string[];
}

/** A validator that has a `.parse()` method (Zod-compatible) or is a function. */
export interface ActionInputValidator<T> {
  parse(input: unknown): T;
}

/** Context passed to a defined action. */
export interface ActionContext {
  /** The original Web Request. */
  request: Request;
  /** AbortSignal from the request — aborts if the client disconnects. */
  signal: AbortSignal;
  /** Idempotency key from the request header, if present. */
  idempotencyKey?: string;
  /** Route params (for page-scoped actions). */
  params: Record<string, string | string[]>;
  /** Per-request locals (populated by middleware). */
  locals: Record<string, unknown>;
}

/** A defined action function. */
export type DefinedActionFn<TInput, TOutput> = (
  input: TInput,
  ctx: ActionContext,
) => Promise<TOutput | ActionFailure<TOutput>>;

/** The return type of defineAction(): a callable with metadata. */
export interface DefinedAction<TInput, TOutput> {
  (input: TInput, ctx: ActionContext): Promise<TOutput | ActionFailure<TOutput>>;
  /** Metadata for the action (used by the runtime/manifest). */
  __nixAction: {
    name: string;
    concurrency: ActionConcurrencyMode;
    idempotent: boolean;
    invalidateTags: readonly string[];
    invalidatePaths: readonly string[];
  };
}

/**
 * Defines a typed server action with validation, abort support, and cache
 * invalidation metadata.
 *
 * ```ts
 * import { defineAction, fail } from "@deijose/nix-js-kit/action";
 *
 * export const submitContact = defineAction({
 *   input: { parse: (v) => v as { name: string; email: string } },
 *   invalidateTags: ["contacts"],
 * }, async (input, ctx) => {
 *   if (!input.email.includes("@")) return fail(400, { email: "Invalid" });
 *   await saveContact(input);
 *   return { success: true };
 * });
 * ```
 *
 * Legacy exported async functions (without `defineAction`) continue to work
 * as before — this is an opt-in upgrade.
 */
export function defineAction<TInput = unknown, TOutput = unknown>(
  options: DefineActionOptions<TInput>,
  handler: DefinedActionFn<TInput, TOutput>,
): DefinedAction<TInput, TOutput> {
  const concurrency = options.concurrency ?? "latest";
  const idempotent = options.idempotent ?? false;
  const invalidateTags = options.invalidateTags ?? [];
  const invalidatePaths = options.invalidatePaths ?? [];

  // Track in-flight calls for concurrency control.
  let latestController: InstanceType<typeof AbortControllerCtor> | null = null;
  const queue: Array<() => void> = [];
  let running = 0;

  async function run(
    input: TInput,
    ctx: ActionContext,
  ): Promise<TOutput | ActionFailure<TOutput>> {
    // Validate input if a validator is configured.
    if (options.input) {
      try {
        const validated = options.input.parse(input);
        input = validated;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const { fail } = await import("../errors.js");
        return fail(400, { validation: message }) as ActionFailure<TOutput>;
      }
    }

    return handler(input, ctx);
  }

  const fn = async (input: TInput, ctx: ActionContext): Promise<TOutput | ActionFailure<TOutput>> => {
    if (concurrency === "latest") {
      // Cancel any previous in-flight call.
      if (latestController) latestController.abort();
      latestController = new AbortControllerCtor();
      // Combine the request signal with our cancellation signal.
      const combinedSignal = combineSignals(ctx.signal, latestController.signal);
      return run(input, { ...ctx, signal: combinedSignal });
    }

    if (concurrency === "queue") {
      // Wait for previous calls to finish.
      if (running > 0) {
        await new Promise<void>((resolve) => queue.push(resolve));
      }
      running++;
      try {
        return await run(input, ctx);
      } finally {
        running--;
        const next = queue.shift();
        if (next) next();
      }
    }

    // parallel: just run it.
    return run(input, ctx);
  };

  // Attach metadata.
  (fn as DefinedAction<TInput, TOutput>).__nixAction = {
    name: handler.name || "anonymous",
    concurrency,
    idempotent,
    invalidateTags,
    invalidatePaths,
  };

  return fn as DefinedAction<TInput, TOutput>;
}

/** Combines two AbortSignals into one that aborts when either does. */
function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortControllerCtor();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}
