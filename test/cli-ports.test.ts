import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { listenWithFallback, MAX_PORT_FALLBACK_TRIES } from "../src/cli/ports.ts";

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolvePromise());
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

/** Takes a free port by binding port 0 and returning the assigned one. */
async function takeFreePort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

describe("listenWithFallback", () => {
  it("listens on the requested port when it is free", async () => {
    const probe = await takeFreePort();
    await close(probe.server);
    const server = createServer();
    const used = await listenWithFallback(server, "127.0.0.1", probe.port);
    assert.equal(used, probe.port);
    await close(server);
  });

  it("falls back to the next port when busy and reports each skip", async () => {
    const blocker = await takeFreePort();
    const server = createServer();
    const fallbacks: Array<[number, number]> = [];
    const used = await listenWithFallback(server, "127.0.0.1", blocker.port, {
      onFallback: (busy, next) => fallbacks.push([busy, next]),
    });
    assert.equal(used, blocker.port + 1);
    assert.deepEqual(fallbacks, [[blocker.port, blocker.port + 1]]);
    await close(server);
    await close(blocker.server);
  });

  it("rejects with EADDRINUSE when the fallback range is exhausted", async () => {
    const first = await takeFreePort();
    const second = createServer();
    await listen(second, first.port + 1);
    const server = createServer();
    await assert.rejects(
      listenWithFallback(server, "127.0.0.1", first.port, { maxTries: 1 }),
      (err: NodeJS.ErrnoException) => err.code === "EADDRINUSE",
    );
    server.close();
    await close(second);
    await close(first.server);
  });

  it("rejects non-port errors without retrying", async () => {
    const server = createServer();
    await assert.rejects(
      listenWithFallback(server, "invalid.host.name.that.does.not.exist", 8080),
      (err: NodeJS.ErrnoException) => err.code !== "EADDRINUSE",
    );
    server.close();
  });

  it("defaults to 20 fallback tries", () => {
    assert.equal(MAX_PORT_FALLBACK_TRIES, 20);
  });
});
