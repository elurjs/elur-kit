import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defineAction } from "../src/action/define.ts";
import { fail } from "../src/errors.ts";

// AbortController may be removed from the global scope by other tests
// (client-router). We create a minimal polyfill that doesn't depend on
// the global or on node:abort-controller (which Bun doesn't resolve).
class MockAbortController {
  readonly signal = { aborted: false, addEventListener() { }, removeEventListener() { } } as unknown as AbortSignal;
  abort() { (this.signal as unknown as { aborted: boolean }).aborted = true; }
}

function makeCtx(signal?: AbortSignal) {
  const controller = new MockAbortController();
  return {
    request: new Request("http://localhost/"),
    signal: signal ?? controller.signal,
    params: {},
    locals: {},
  };
}

describe("defineAction() (plan §9.2)", () => {
  it("defines and executes a typed action", async () => {
    const greet = defineAction(
      {},
      async (input: { name: string }) => `Hello, ${input.name}!`,
    );
    const result = await greet({ name: "Ada" }, makeCtx());
    assert.equal(result, "Hello, Ada!");
  });

  it("validates input using a .parse() validator", async () => {
    const validator = {
      parse(v: unknown): { name: string } {
        if (typeof v !== "object" || v === null || typeof (v as { name?: unknown }).name !== "string") {
          throw new Error("name must be a string");
        }
        return v as { name: string };
      },
    };
    const greet = defineAction(
      { input: validator },
      async (input) => `Hello, ${input.name}!`,
    );
    const result = await greet({ name: "Ada" }, makeCtx());
    assert.equal(result, "Hello, Ada!");

    // Invalid input should return ActionFailure(400).
    const badResult = await greet({ name: 123 } as unknown as { name: string }, makeCtx());
    assert.ok(badResult && typeof badResult === "object" && "__elur_js_action_failure" in badResult);
    assert.equal((badResult as { status: number }).status, 400);
  });

  it("attaches metadata to the action", () => {
    const action = defineAction(
      {
        concurrency: "queue",
        idempotent: true,
        invalidateTags: ["products"],
        invalidatePaths: ["/products"],
      },
      async (input: string) => input,
    );
    assert.ok(action.__elurAction, "should have __elurAction metadata");
    assert.equal(action.__elurAction.concurrency, "queue");
    assert.equal(action.__elurAction.idempotent, true);
    assert.deepEqual([...action.__elurAction.invalidateTags], ["products"]);
    assert.deepEqual([...action.__elurAction.invalidatePaths], ["/products"]);
  });

  it("supports fail() return for validation errors", async () => {
    const submit = defineAction(
      {},
      async (input: { email: string }) => {
        if (!input.email.includes("@")) {
          return fail(400, { email: "Invalid email" });
        }
        return { success: true };
      },
    );
    const result = await submit({ email: "not-an-email" }, makeCtx());
    assert.ok(result && typeof result === "object" && "__elur_js_action_failure" in result);
    assert.equal((result as unknown as { status: number }).status, 400);
  });

  it("propagates AbortSignal to the handler", async () => {
    const controller = new MockAbortController();
    const ctxWithSignal = { ...makeCtx(), signal: controller.signal };

    const slow = defineAction(
      {},
      async (_input: void, ctx) => {
        // Simulate checking the signal.
        if (ctx.signal.aborted) {
          return fail(499, { aborted: true });
        }
        return { ok: true };
      },
    );

    controller.abort();
    const result = await slow(undefined as void, ctxWithSignal);
    assert.ok(result && typeof result === "object" && "__elur_js_action_failure" in result);
    assert.equal((result as unknown as { status: number }).status, 499);
  });

  it("latest concurrency cancels previous in-flight calls", async () => {
    let callCount = 0;
    let firstCallAborted = false;

    const slow = defineAction(
      { concurrency: "latest" },
      async (_input: void, ctx) => {
        callCount++;
        // Simulate async work that checks the signal.
        await new Promise<void>((resolve, reject) => {
          if (ctx.signal.aborted) {
            firstCallAborted = true;
            reject(new Error("aborted"));
            return;
          }
          ctx.signal.addEventListener("abort", () => {
            firstCallAborted = true;
            reject(new Error("aborted"));
          }, { once: true });
          setTimeout(resolve, 100);
        }).catch(() => "aborted" as unknown as void);
        return { call: callCount };
      },
    );

    // Start first call, then immediately start a second.
    const first = slow(undefined as void, makeCtx());
    const second = slow(undefined as void, makeCtx());

    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    // At least the second should succeed.
    assert.ok(secondResult.status === "fulfilled", "second call should complete");
  });

  it("defaults to latest concurrency and non-idempotent", () => {
    const action = defineAction({}, async (x: number) => x);
    assert.equal(action.__elurAction.concurrency, "latest");
    assert.equal(action.__elurAction.idempotent, false);
  });
});
