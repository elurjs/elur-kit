import type { IncomingMessage, ServerResponse } from "node:http";

// Capture the global AbortController at module load time so it's immune to
// test frameworks that replace or delete globalThis.AbortController.
const GlobalAbortController =
  (globalThis as { AbortController?: typeof AbortController }).AbortController ?? AbortController;

export function incomingMessageToRequest(req: IncomingMessage, body?: BodyInit | null): Request {
  const headers = new Headers();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    headers.append(req.rawHeaders[index], req.rawHeaders[index + 1]);
  }

  const controller = new GlobalAbortController();
  req.once("aborted", () => controller.abort());
  req.once("close", () => {
    if (!req.complete) controller.abort();
  });

  const protocol = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted ? "https" : "http";
  const init: RequestInit = {
    method: req.method ?? "GET",
    headers,
    signal: controller.signal,
  };
  if (body !== undefined && body !== null && init.method !== "GET" && init.method !== "HEAD") init.body = body;

  return new Request(`${protocol}://${headers.get("host") ?? "localhost"}${req.url ?? "/"}`, init);
}

/**
 * Writes a Web `Response` to a Node `ServerResponse`, streaming the body.
 *
 * Unlike `res.end(Buffer.from(await response.arrayBuffer()))`, this forwards
 * chunks as they are produced — required for streaming SSR responses to reach
 * the client progressively. Buffered (non-stream) bodies behave exactly as
 * before. Honors backpressure (`drain`) and cancels the upstream stream when
 * the client disconnects (`close` before `finish`).
 */
export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers = Object.fromEntries(response.headers.entries());
  if (response.body !== null) {
    // Chunk boundaries are decided as the body is read; a Content-Length
    // captured earlier would be wrong for streams. Transfer-Encoding is
    // managed by Node itself (it chunks when no length is set) — forwarding
    // it would duplicate the header (`chunked, chunked`).
    delete headers["content-length"];
    delete headers["transfer-encoding"];
  }
  res.writeHead(response.status, headers);

  const body = response.body;
  if (!body) {
    res.end();
    return;
  }

  const reader = body.getReader();
  let done = false;
  const onClose = () => {
    if (!done) void reader.cancel().catch(() => {});
  };
  res.once("close", onClose);

  try {
    for (;;) {
      const { done: readDone, value } = await reader.read();
      if (readDone) break;
      if (value && value.byteLength > 0 && !res.write(value)) {
        // Socket buffer is full: wait for it to drain before reading more.
        await new Promise<void>((resolveDrain) => res.once("drain", resolveDrain));
      }
    }
    done = true;
    res.end();
  } catch {
    done = true;
    // The client went away or the upstream stream failed: tear the socket
    // down instead of leaving a half-written response hanging.
    res.destroy();
  } finally {
    res.removeListener("close", onClose);
  }
}
