/**
 * The bridge between `node:http` and the Web `Request`/`Response` objects the routes work on (the
 * SDK has no Node adapter of its own, and we add no framework).
 *
 * Requests arrive as an {@link IncomingRequest}: method, target and headers first, the body only
 * when the router asks for it, with the limit of the matched route. A body over the limit is
 * never buffered past the limit (a declared `Content-Length` is checked before reading a byte):
 * the rest is read and thrown away, up to {@link DISCARD_LIMIT_BYTES}, before the 413 is
 * reported, so the client receives the 413 instead of a connection reset; beyond that budget the
 * connection is closed. Bodies are small (1 MiB at most), so they are buffered: handlers never see
 * a truncated stream.
 *
 * Responses are streamed: every chunk is written as it arrives (SSE events are not buffered),
 * with backpressure, and stop when the client goes away. The request's {@link
 * IncomingRequest.signal} fires on client disconnect.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** One request before its body is read; see the module comment. */
export interface IncomingRequest {
  /** Upper-case method. */
  readonly method: string;
  /** The request target as received (origin-form: path and query). */
  readonly target: string;
  readonly headers: Headers;
  /** The TCP peer address (a proxy, when there is one). */
  readonly remoteAddress: string | undefined;
  /** Aborted when the client disconnects before the response is complete. */
  readonly signal: AbortSignal;
  /**
   * Reads the whole body: its bytes, or `"too_large"` when more than `maxBytes` are declared or
   * arrive (reading stops there). Rejects when the client aborts mid-body. Call at most once.
   * `onData` hears the size of every chunk as it arrives (the router's pace check).
   */
  readBody(maxBytes: number, onData?: (bytes: number) => void): Promise<Uint8Array | "too_large">;
  /** Whether a declared body is (partly) unread: the connection must not be reused. */
  readonly bodyPending: boolean;
}

/** Headers that describe one hop, not the message; not passed on to handlers. */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

/**
 * Bytes past a route's limit that are read and discarded so the 413 reaches the client (closing a
 * socket with unread data makes the kernel answer with a reset). Larger bodies get the 413 with
 * `Connection: close`, or the socket is dropped once the budget runs out mid-stream.
 */
export const DISCARD_LIMIT_BYTES = 8 * 1024 * 1024;

/** Statuses whose responses never carry a body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

/** Adapts a `node:http` request; `res` provides the disconnect signal. */
export function fromNodeRequest(req: IncomingMessage, res: ServerResponse): IncomingRequest {
  const headers = new Headers();
  for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index] ?? "";
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers.append(name, req.rawHeaders[index + 1] ?? "");
  }
  const disconnect = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) disconnect.abort(new Error("The client disconnected."));
  });
  const declared = declaresBody(req.headers["content-length"], req.headers["transfer-encoding"]);
  // Set once the body is read, or being discarded in the background.
  let handled = false;
  let reading = false;
  return {
    method: (req.method ?? "GET").toUpperCase(),
    target: req.url ?? "",
    headers,
    remoteAddress: req.socket.remoteAddress,
    signal: disconnect.signal,
    get bodyPending() {
      return declared && !handled;
    },
    async readBody(maxBytes, onData) {
      if (reading) throw new Error("The request body was already read.");
      reading = true;
      const length = declaredLength(req.headers["content-length"]);
      if (length > maxBytes) {
        if (length - maxBytes <= DISCARD_LIMIT_BYTES) {
          handled = true;
          await discardBody(req, 0, length);
        }
        return "too_large";
      }
      const body = await readNodeBody(req, maxBytes, onData);
      handled = true;
      return body;
    },
  };
}

/**
 * Adapts a Web `Request` (in-process requests: tests, the OAuth E2E's injected `fetch`). A request
 * without `Host` gets the one its URL implies, as a real `fetch` would send.
 */
export function fromWebRequest(request: Request, remoteAddress = "127.0.0.1"): IncomingRequest {
  const url = new URL(request.url);
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!HOP_BY_HOP.has(name)) headers.append(name, value);
  }
  if (!headers.has("host")) headers.set("host", url.host);
  let reading = false;
  let consumed = request.body === null;
  return {
    method: request.method.toUpperCase(),
    target: `${url.pathname}${url.search}`,
    headers,
    remoteAddress,
    signal: request.signal,
    get bodyPending() {
      return !consumed;
    },
    async readBody(maxBytes, onData) {
      if (reading) throw new Error("The request body was already read.");
      reading = true;
      if (declaredLength(request.headers.get("content-length") ?? undefined) > maxBytes) {
        return "too_large";
      }
      if (request.body === null) return new Uint8Array();
      const reader = (request.body as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        onData?.(value.byteLength);
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return "too_large";
        }
        chunks.push(value);
      }
      consumed = true;
      return concat(chunks, size);
    },
  };
}

export interface WriteResponseOptions {
  /** `HEAD`: send the headers only. */
  readonly head: boolean;
  /** Send `Connection: close` (draining, or an unread request body). */
  readonly closeConnection: boolean;
}

/**
 * Writes `response` to `res`, streaming its body chunk by chunk (headers are flushed first, so an
 * SSE stream starts immediately). Stops reading the body when the client is gone. Never throws.
 */
export async function writeNodeResponse(
  res: ServerResponse,
  response: Response,
  options: WriteResponseOptions,
): Promise<void> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  try {
    if (gone(res)) {
      await body?.cancel().catch(() => undefined);
      return;
    }
    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie" && !HOP_BY_HOP.has(name)) headers[name] = value;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) headers["set-cookie"] = cookies;
    if (options.closeConnection) headers["connection"] = "close";
    res.writeHead(response.status, headers);
    if (body === null || options.head || NULL_BODY_STATUSES.has(response.status)) {
      await body?.cancel().catch(() => undefined);
      res.end();
      return;
    }
    res.flushHeaders();
    const reader = body.getReader();
    // A client that leaves while the body waits for its next chunk cancels the stream (an idle
    // SSE stream would otherwise be held open until it produced data).
    const onClose = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    res.once("close", onClose);
    try {
      for (;;) {
        if (gone(res)) {
          await reader.cancel().catch(() => undefined);
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) await drained(res);
      }
    } finally {
      res.off("close", onClose);
      reader.releaseLock();
    }
    res.end();
  } catch {
    // A failing body stream or socket: nothing more can be sent; drop the connection so the
    // client sees an incomplete response instead of a truncated success.
    res.destroy();
  }
}

/** Whether the client is gone (a function, so TypeScript does not narrow the flag). */
function gone(res: ServerResponse): boolean {
  return res.destroyed;
}

/** Resolves when `res` can take more data, or is closed. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

function readNodeBody(
  req: IncomingMessage,
  maxBytes: number,
  onData: ((bytes: number) => void) | undefined,
): Promise<Uint8Array | "too_large"> {
  return new Promise((resolve, reject) => {
    if (req.readableEnded) {
      resolve(new Uint8Array());
      return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const cleanup = (): void => {
      req.off("data", onChunk);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    };
    const onChunk = (chunk: Buffer): void => {
      size += chunk.byteLength;
      onData?.(chunk.byteLength);
      if (size > maxBytes) {
        cleanup();
        void discardBody(req, size, maxBytes + DISCARD_LIMIT_BYTES).then(() => {
          resolve("too_large");
        });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(concat(chunks, size));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("The client disconnected while sending the request body."));
    };
    req.on("data", onChunk);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

/**
 * Reads the rest of `req` and throws it away; `seen` bytes were already read. Resolves when the
 * body has ended (or the client left); destroys the socket once more than `limit` bytes arrived in
 * total. Bounded in time by the server's `requestTimeout`.
 */
function discardBody(req: IncomingMessage, seen: number, limit: number): Promise<void> {
  return new Promise((resolve) => {
    if (req.readableEnded) {
      resolve();
      return;
    }
    let size = seen;
    const done = (): void => {
      req.off("data", onData);
      req.off("end", done);
      req.off("error", done);
      req.off("close", done);
      resolve();
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.byteLength;
      if (size > limit) {
        done();
        req.socket.destroy();
      }
    };
    req.on("data", onData);
    req.on("end", done);
    req.on("error", done);
    req.on("close", done);
    req.resume();
  });
}

function declaresBody(
  contentLength: string | undefined,
  transferEncoding: string | undefined,
): boolean {
  return transferEncoding !== undefined || declaredLength(contentLength) > 0;
}

/** The declared `Content-Length`, 0 when absent or malformed (node rejects malformed ones). */
function declaredLength(contentLength: string | undefined): number {
  if (contentLength === undefined || !/^\d+$/.test(contentLength.trim())) return 0;
  return Number(contentLength.trim());
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
