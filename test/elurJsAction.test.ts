import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { elurJsAction } from "../src/action/index.ts";

describe("elurJsAction", () => {
  let originalFetch: typeof fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("tracks pending, data, and error signals", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify("Hello, Ada!"), { status: 200, headers: { "Content-Type": "application/json" } });

    const greet = elurJsAction("greet", { page: "/" });
    assert.equal(greet.pending.value, false);
    assert.equal(greet.data.value, null);
    assert.equal(greet.error.value, null);

    const promise = greet.submit("Ada");
    assert.equal(greet.pending.value, true);
    await promise;
    assert.equal(greet.pending.value, false);
    assert.equal(greet.data.value, "Hello, Ada!");
    assert.equal(greet.error.value, null);
  });

  it("captures errors in the error signal", async () => {
    globalThis.fetch = async () =>
      new Response("boom", { status: 500, statusText: "Internal Server Error" });

    const greet = elurJsAction("greet", { page: "/" });
    await assert.rejects(() => greet.submit("Ada"), /Action "greet" failed/);
    assert.equal(greet.data.value, null);
    assert.ok(greet.error.value instanceof Error);
    assert.ok(greet.error.value?.message.includes('Action "greet" failed'));
  });
});
