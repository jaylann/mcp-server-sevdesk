import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  DISCARD_LIMIT_BYTES,
  fromNodeRequest,
  fromWebRequest,
  type IncomingRequest,
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
    void serveWith(async (incoming) => {
      await incoming.readBody(10);
      return new Response(null, { status: 413 });
    });
    const exchange = openRequest(port, {
      method: "POST",
      headers: { "Transfer-Encoding": "chunked" },
    });
    const closed = new Promise<void>((resolve) => exchange.request.on("close", resolve));
    exchange.request.on("error", () => undefined);
    const chunk = Buffer.alloc(1024 * 1024, 120);
    for (let index = 0; index < 10; index += 1) exchange.request.write(chunk);
    exchange.request.end();
    await closed;
    expect(exchange.request.destroyed).toBe(true);
  });

  it("rejects the body read when the client goes away mid-body, and aborts the signal", async () => {
    const outcome = deferred<{ error: unknown; signal: AbortSignal }>();
    void serveWith(async (incoming) => {
      try {
        await incoming.readBody(1_000);
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
    await vi.waitFor(() => {
      expect(exchange.request.writableLength).toBe(0);
    });
    exchange.request.destroy();
    const { error, signal } = await outcome.promise;
    expect(error).toBeInstanceOf(Error);
    await vi.waitFor(() => {
      expect(signal.aborted).toBe(true);
    });
  });

  it("aborts the signal when the client disconnects while the handler runs", async () => {
    const aborted = deferred();
    void serveWith(async (incoming) => {
      await new Promise<void>((resolve) => {
        incoming.signal.addEventListener("abort", () => {
          resolve();
        });
      });
      aborted.resolve();
      return new Response("late");
    });
    const exchange = openRequest(port, { path: "/slow" });
    exchange.request.end();
    await vi.waitFor(() => {
      expect(exchange.request.writableFinished).toBe(true);
    });
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
    void serveWith(async (incoming) => {
      await new Promise<void>((resolve) => {
        incoming.signal.addEventListener("abort", () => {
          resolve();
        });
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
    await vi.waitFor(() => {
      expect(exchange.request.writableFinished).toBe(true);
    });
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
