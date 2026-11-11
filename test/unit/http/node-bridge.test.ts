import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo, connect } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  DISCARD_LIMIT_BYTES,
  fromNodeRequest,
  fromWebRequest,
  type IncomingRequest,
  WRITE_SLICE_BYTES,
  writeNodeResponse,
} from "../../../src/http/node-bridge.js";
import { openRequest, rawRequest } from "../../helpers/http-raw.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

let server: Server;
let port: number;
let handler: Handler = (_req, res) => {
  res.end();
};

beforeAll(async () => {
  server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Runs `use` with the adapted request, then writes what it returns. */
function serveWith(use: (incoming: IncomingRequest) => Promise<Response>, closeConnection = false) {
  const seen = deferred<IncomingRequest>();
  handler = async (req, res) => {
    const incoming = fromNodeRequest(req, res);
    seen.resolve(incoming);
    const response = await use(incoming);
    await writeNodeResponse(res, response, {
      head: incoming.method === "HEAD",
      closeConnection: closeConnection || incoming.bodyPending,
    });
  };
  return seen.promise;
}

describe("fromNodeRequest", () => {
  it("adapts method, target, headers and peer, dropping hop-by-hop headers", async () => {
    const chunks: number[] = [];
    const seen = serveWith(async (incoming) => {
      const body = await incoming.readBody(100, (bytes) => chunks.push(bytes));
      return new Response(body === "too_large" ? "too large" : new TextDecoder().decode(body));
    });
    const response = await rawRequest(port, {
      method: "POST",
      path: "/mcp?x=1",
      headers: { "X-Custom": "a", Connection: "keep-alive", "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(response.body).toBe("hello");
    expect(chunks.reduce((sum, bytes) => sum + bytes, 0)).toBe(5);
    const incoming = await seen;
    expect(incoming.method).toBe("POST");
    expect(incoming.target).toBe("/mcp?x=1");
    expect(incoming.headers.get("x-custom")).toBe("a");
    expect(incoming.headers.get("host")).toBe(`127.0.0.1:${String(port)}`);
    expect(incoming.headers.has("connection")).toBe(false);
    expect(incoming.remoteAddress).toMatch(/127\.0\.0\.1$/);
    expect(incoming.bodyPending).toBe(false);
    await expect(incoming.readBody(100)).rejects.toThrow(/already read/);
  });

  it("refuses a declared oversized body before reading it, and discards the rest", async () => {
    const seen = serveWith(async (incoming) => {
      expect(await incoming.readBody(10)).toBe("too_large");
      return new Response("too large", { status: 413 });
    });
    // 1 MiB past the limit: the client keeps sending while the 413 is already on its way.
    const response = await rawRequest(port, { method: "POST", body: "x".repeat(1024 * 1024) });
    expect(response.status).toBe(413);
    expect(response.body).toBe("too large");
    expect((await seen).bodyPending).toBe(false);
  });

  it("closes the connection for a declared body far beyond the discard budget", async () => {
    const seen = serveWith(async (incoming) => {
      expect(await incoming.readBody(10)).toBe("too_large");
      return new Response(null, { status: 413 });
    });
    const exchange = openRequest(port, {
      method: "POST",
      headers: { "Content-Length": String(10 + DISCARD_LIMIT_BYTES + 1) },
      body: "abc",
    });
    const head = await exchange.response;
    expect(head.statusCode).toBe(413);
    expect(head.headers["connection"]).toBe("close");
    expect((await seen).bodyPending).toBe(true);
    exchange.request.destroy();
  });

  it("stops buffering a chunked body once it passes the limit and keeps the connection", async () => {
    const result = deferred<Uint8Array | "too_large">();
    const seen = serveWith(async (incoming) => {
      result.resolve(await incoming.readBody(10));
      return new Response(null, { status: 413 });
    });
    const exchange = openRequest(port, {
      method: "POST",
      headers: { "Transfer-Encoding": "chunked", Connection: "keep-alive" },
    });
    exchange.request.write("x".repeat(8));
    exchange.request.write("y".repeat(8));
    exchange.request.end("z".repeat(8));
    expect(await result.promise).toBe("too_large");
    const head = await exchange.response;
    expect(head.statusCode).toBe(413);
    expect(head.headers["connection"]).not.toBe("close");
    expect((await seen).bodyPending).toBe(false);
  });

  it("drops the connection once a streamed body exceeds the discard budget", async () => {
    // Whether the server closed the socket while the request was still incomplete.
    const cut = deferred<{ incomplete: boolean; discarded: number }>();
    handler = async (req, res) => {
      let discarded = 0;
      req.on("data", (chunk: Buffer) => {
        discarded += chunk.byteLength;
      });
      req.socket.once("close", () => {
        cut.resolve({ incomplete: !req.complete, discarded });
      });
      const incoming = fromNodeRequest(req, res);
      await incoming.readBody(10);
      await writeNodeResponse(res, new Response(null, { status: 413 }), {
        head: false,
        closeConnection: true,
      });
    };
    const exchange = openRequest(port, {
      method: "POST",
      headers: { "Transfer-Encoding": "chunked" },
    });
    const closed = new Promise<void>((resolve) => exchange.request.on("close", resolve));
    exchange.request.on("error", () => undefined);
    const chunk = Buffer.alloc(1024 * 1024, 120);
    for (let index = 0; index < 10; index += 1) exchange.request.write(chunk);
    // The request is never ended: only the server can close this connection. A server without
    // the budget would keep reading, and the test would time out.
    const { incomplete, discarded } = await cut.promise;
    expect(incomplete).toBe(true);
    expect(discarded).toBeGreaterThan(DISCARD_LIMIT_BYTES);
    expect(discarded).toBeLessThanOrEqual(10 * 1024 * 1024);
    await closed;
    expect(exchange.request.writableEnded).toBe(false);
    expect(exchange.request.destroyed).toBe(true);
  });

  it("rejects the body read when the client goes away mid-body, and aborts the signal", async () => {
    const outcome = deferred<{ error: unknown; signal: AbortSignal }>();
    // Resolved on the server once the partial body has arrived there: only then does the
    // disconnect happen mid-body for certain (a client-side check races with the server).
    const arrived = deferred();
    void serveWith(async (incoming) => {
      try {
        await incoming.readBody(1_000, (bytes) => {
          if (bytes > 0) arrived.resolve();
        });
      } catch (error) {
        outcome.resolve({ error, signal: incoming.signal });
      }
      return new Response(null, { status: 400 });
    });
    const exchange = openRequest(port, {
      method: "POST",
      headers: { "Content-Length": "100" },
      body: "partial",
    });
    await arrived.promise;
    exchange.request.destroy();
    const { error, signal } = await outcome.promise;
    expect(error).toBeInstanceOf(Error);
    await vi.waitFor(() => {
      expect(signal.aborted).toBe(true);
    });
  });

  it("aborts the signal when the client disconnects while the handler runs", async () => {
    const aborted = deferred();
    // Resolved on the server once the handler listens for the abort.
    const listening = deferred();
    void serveWith(async (incoming) => {
      expect(incoming.signal.aborted).toBe(false);
      await new Promise<void>((resolve) => {
        incoming.signal.addEventListener("abort", () => {
          resolve();
        });
        listening.resolve();
      });
      aborted.resolve();
      return new Response("late");
    });
    const exchange = openRequest(port, { path: "/slow" });
    exchange.request.end();
    await listening.promise;
    exchange.request.destroy();
    await aborted.promise;
  });
});

describe("writeNodeResponse", () => {
  it("streams each chunk as it is produced (SSE is not buffered)", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    void serveWith(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );
    const exchange = openRequest(port);
    exchange.request.end();
    const head = await exchange.response;
    expect(head.headers["content-type"]).toBe("text/event-stream");
    controller.enqueue(encoder.encode("data: one\n\n"));
    expect(await exchange.next()).toBe("data: one\n\n");
    controller.enqueue(encoder.encode("data: two\n\n"));
    expect(await exchange.next()).toBe("data: two\n\n");
    controller.close();
    expect(await exchange.next()).toBeUndefined();
  });

  it("writes every Set-Cookie header and no body for HEAD or 204", async () => {
    const response = () => {
      const headers = new Headers({ "Content-Type": "text/plain" });
      headers.append("Set-Cookie", "a=1; HttpOnly");
      headers.append("Set-Cookie", "b=2; HttpOnly");
      return new Response("body", { headers });
    };
    void serveWith(() => Promise.resolve(response()));
    const get = await rawRequest(port);
    expect(get.headers["set-cookie"]).toEqual(["a=1; HttpOnly", "b=2; HttpOnly"]);
    expect(get.body).toBe("body");

    void serveWith(() => Promise.resolve(response()));
    const head = await rawRequest(port, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");

    void serveWith(() => Promise.resolve(new Response(null, { status: 204 })), true);
    const empty = await rawRequest(port);
    expect(empty.status).toBe(204);
    expect(empty.headers["connection"]).toBe("close");
  });

  it("drops the connection when the body stream fails midway", async () => {
    void serveWith(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("upstream failed"));
            },
          }),
        ),
      ),
    );
    await expect(rawRequest(port)).rejects.toThrow();
  });

  it("cancels the body when the client is already gone", async () => {
    const cancelled = deferred();
    // Resolved on the server once the handler waits for the disconnect.
    const listening = deferred();
    void serveWith(async (incoming) => {
      expect(incoming.signal.aborted).toBe(false);
      await new Promise<void>((resolve) => {
        incoming.signal.addEventListener("abort", () => {
          resolve();
        });
        listening.resolve();
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled.resolve();
          },
        }),
      );
    });
    const exchange = openRequest(port);
    exchange.request.end();
    await listening.promise;
    exchange.request.destroy();
    await cancelled.promise;
  });

  it("stops streaming when the client disconnects", async () => {
    const cancelled = deferred();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    void serveWith(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
            },
            cancel() {
              cancelled.resolve();
            },
          }),
        ),
      ),
    );
    const exchange = openRequest(port);
    exchange.request.end();
    await exchange.response;
    controller.enqueue(new TextEncoder().encode("first"));
    expect(await exchange.next()).toBe("first");
    // The stream now idles; the client leaving must still cancel it.
    exchange.request.destroy();
    await cancelled.promise;
  });
});

describe("fromWebRequest", () => {
  it("adds the Host its URL implies and reads the body within the limit", async () => {
    const incoming = fromWebRequest(
      new Request("http://localhost:8080/mcp?x=1", { method: "POST", body: "abc" }),
      "10.0.0.1",
    );
    expect(incoming.headers.get("host")).toBe("localhost:8080");
    expect(incoming.target).toBe("/mcp?x=1");
    expect(incoming.remoteAddress).toBe("10.0.0.1");
    expect(incoming.bodyPending).toBe(true);
    const chunks: number[] = [];
    const body = await incoming.readBody(3, (bytes) => chunks.push(bytes));
    expect(new TextDecoder().decode(body as Uint8Array)).toBe("abc");
    expect(chunks).toEqual([3]);
    expect(incoming.bodyPending).toBe(false);
    await expect(incoming.readBody(3)).rejects.toThrow(/already read/);
  });

  it("refuses oversized bodies, declared or streamed", async () => {
    const declared = fromWebRequest(
      new Request("http://localhost/x", {
        method: "POST",
        body: "abcd",
        headers: { "Content-Length": "4" },
      }),
    );
    expect(await declared.readBody(3)).toBe("too_large");
    const streamed = fromWebRequest(
      new Request("http://localhost/x", { method: "POST", body: "abcd" }),
    );
    expect(await streamed.readBody(3)).toBe("too_large");
    const empty = fromWebRequest(new Request("http://localhost/x", { method: "POST" }));
    expect(await empty.readBody(3)).toEqual(new Uint8Array());
    expect(empty.bodyPending).toBe(false);
  });
});

describe("writeNodeResponse: a client that stops reading (security review 2026-11, finding 5)", () => {
  /** A response whose socket never drains, as when the client stops reading. */
  function stalledResponse() {
    const events = new EventEmitter();
    const res = Object.assign(events, {
      destroyed: false,
      writeHead: () => res,
      flushHeaders: () => undefined,
      write: () => false,
      end: () => undefined,
      destroy: () => {
        res.destroyed = true;
        events.emit("close");
        return res;
      },
    });
    return res;
  }

  it("drops the connection once a write waited stallMs, ending the response", async () => {
    vi.useFakeTimers();
    try {
      const res = stalledResponse();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled = true;
        },
      });
      const writing = writeNodeResponse(res as unknown as ServerResponse, new Response(body), {
        head: false,
        closeConnection: false,
        stallMs: 5_000,
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(res.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await writing;
      expect(res.destroyed).toBe(true);
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("writeNodeResponse: a slow but steady reader (review 2026-11, round 3)", () => {
  const MIB = 1024 * 1024;

  it("writes a large chunk in slices, so the stall timer does not measure the whole body", async () => {
    vi.useFakeTimers();
    try {
      // A client that takes 64 KiB every 4 s: each write drains after its size at that speed.
      const events = new EventEmitter();
      const written: number[] = [];
      let ended = false;
      const res = Object.assign(events, {
        destroyed: false,
        writeHead: () => res,
        flushHeaders: () => undefined,
        write: (chunk: Uint8Array) => {
          written.push(chunk.byteLength);
          setTimeout(() => events.emit("drain"), (chunk.byteLength / WRITE_SLICE_BYTES) * 4_000);
          return false;
        },
        end: () => {
          ended = true;
        },
        destroy: () => {
          res.destroyed = true;
          events.emit("close");
          return res;
        },
      });
      // One chunk, as a download is: 1 MiB takes 64 s at this speed, far past the 5 s stall time.
      const writing = writeNodeResponse(
        res as unknown as ServerResponse,
        new Response(new Uint8Array(MIB + 10)),
        { head: false, closeConnection: false, stallMs: 5_000 },
      );
      await vi.advanceTimersByTimeAsync(70_000);
      await writing;
      expect(res.destroyed).toBe(false);
      expect(ended).toBe(true);
      expect(written).toEqual([...Array.from({ length: 16 }, () => WRITE_SLICE_BYTES), 10]);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Serves one response of `size` bytes in one chunk; resolves when the write is over. */
  function serveDownload(size: number, stallMs: number) {
    const done = deferred<{ ms: number; destroyed: boolean }>();
    handler = async (_req, res) => {
      const started = Date.now();
      await writeNodeResponse(
        res,
        new Response(new Uint8Array(size), { headers: { "Content-Length": String(size) } }),
        { head: false, closeConnection: true, stallMs },
      );
      done.resolve({ ms: Date.now() - started, destroyed: res.destroyed });
    };
    return done.promise;
  }

  /** A client on a real socket that takes one read, then nothing for `pauseMs` (never: Infinity). */
  function throttledClient(pauseMs: number) {
    const socket = connect(port, "127.0.0.1");
    let received = 0;
    const closed = new Promise<number>((resolve) => {
      socket.on("close", () => {
        resolve(received);
      });
    });
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      socket.pause();
      if (Number.isFinite(pauseMs)) setTimeout(() => socket.resume(), pauseMs);
    });
    socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    return { socket, closed };
  }

  it("sends the whole body to a client that keeps reading slowly, past stallMs", async () => {
    const size = 16 * MIB;
    const stallMs = 400;
    const served = serveDownload(size, stallMs);
    // At most two reads' worth (128 KiB) every 15 ms: 16 MiB take far longer than stallMs, even
    // with several MiB waiting in the socket buffers.
    const client = throttledClient(15);
    const received = await client.closed;
    const { ms, destroyed } = await served;
    expect(received).toBeGreaterThanOrEqual(size);
    expect(destroyed).toBe(false);
    // The server was writing for longer than the stall time: one write of the whole body would
    // have been cut.
    expect(ms).toBeGreaterThan(stallMs);
  }, 30_000);

  it("still cuts a client that stops reading", async () => {
    const size = 16 * MIB;
    const stallMs = 300;
    const served = serveDownload(size, stallMs);
    const client = throttledClient(Number.POSITIVE_INFINITY);
    const { ms, destroyed } = await served;
    expect(destroyed).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(stallMs - 20);
    expect(ms).toBeLessThan(5_000);
    // What the client finds when it reads on: a body that ends early.
    client.socket.on("data", () => client.socket.resume());
    client.socket.resume();
    expect(await client.closed).toBeLessThan(size);
  }, 30_000);
});
