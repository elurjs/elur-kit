// --- Port fallback for dev/preview servers ---
//
// When the requested port is busy (EADDRINUSE), the server retries on
// port+1, port+2, ... up to MAX_PORT_FALLBACK_TRIES times. Detection is
// error-driven (the listen itself fails) rather than a bind/close probe, so
// there is no TOCTOU race between checking and binding.
//
// When every candidate port is busy the caller should exit with
// PORT_UNAVAILABLE_EXIT_CODE so the dev supervisor does not restart-loop.

import type { Server } from "node:http";

/** Max ports tried after the requested one before giving up. */
export const MAX_PORT_FALLBACK_TRIES = 20;

/**
 * Exit code used when no port in the fallback range is available. The dev
 * supervisor treats it as fatal and does not restart the worker.
 */
export const PORT_UNAVAILABLE_EXIT_CODE = 78;

export interface ListenFallbackOptions {
  /** Max fallbacks after the requested port. Default: MAX_PORT_FALLBACK_TRIES. */
  maxTries?: number;
  /** Called when a busy port is skipped: (busyPort, nextPort). */
  onFallback?: (busyPort: number, nextPort: number) => void;
}

/**
 * Listens on host:port, falling back to the next port while the failure is
 * EADDRINUSE. Resolves with the port actually bound. Rejects with the
 * original error for non-port failures or when the range is exhausted.
 */
export function listenWithFallback(
  server: Server,
  host: string,
  port: number,
  options: ListenFallbackOptions = {},
): Promise<number> {
  const maxTries = options.maxTries ?? MAX_PORT_FALLBACK_TRIES;
  return new Promise((resolvePromise, reject) => {
    let attempt = 0;
    let candidate = port;
    // Shared listeners: the per-listen callback style would leave stale
    // "listening" handlers behind after a failed attempt, resolving with the
    // original (busy) port when the fallback succeeds.
    const onListening = () => {
      server.removeListener("error", onError);
      resolvePromise(candidate);
    };
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      if (err.code === "EADDRINUSE" && attempt < maxTries) {
        attempt++;
        const nextPort = port + attempt;
        options.onFallback?.(nextPort - 1, nextPort);
        tryListen(nextPort);
        return;
      }
      reject(err);
    };
    const tryListen = (next: number) => {
      candidate = next;
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidate, host);
    };
    tryListen(port);
  });
}
