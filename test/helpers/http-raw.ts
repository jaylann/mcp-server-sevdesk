/**
 * A tiny `node:http` client for HTTP-mode tests: unlike `fetch`, it can send any `Host` header,
 * keep a request open, read a streamed response chunk by chunk and drop the connection.
 */
import { type ClientRequest, type IncomingMessage, request as httpRequest } from "node:http";

export interface RawRequest {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export interface RawResponse {
  readonly status: number;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

/** Sends one request on a fresh connection and reads the whole response. */
export function rawRequest(port: number, options: RawRequest = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: options.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

/** An open request whose response is read chunk by chunk. */
export interface StreamingExchange {
  readonly request: ClientRequest;
  /** Resolves with the response head. */
  readonly response: Promise<IncomingMessage>;
  /** The next body chunk as text, or `undefined` at the end. */
  next(): Promise<string | undefined>;
}

/** Starts a request and returns it before the response arrives. */
export function openRequest(port: number, options: RawRequest = {}): StreamingExchange {
  const queue: (string | undefined)[] = [];
  const waiting: ((chunk: string | undefined) => void)[] = [];
  const push = (chunk: string | undefined): void => {
    const waiter = waiting.shift();
    if (waiter === undefined) queue.push(chunk);
    else waiter(chunk);
  };
  let request!: ClientRequest;
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: options.headers,
        agent: false,
      },
      (res) => {
        res.on("data", (chunk: Buffer) => {
          push(chunk.toString("utf8"));
        });
        res.on("end", () => {
          push(undefined);
        });
        res.on("error", () => {
          push(undefined);
        });
        resolve(res);
      },
    );
    request.on("error", (error) => {
      push(undefined);
      reject(error);
    });
  });
  // Avoid unhandled rejections when a test destroys the request on purpose.
  response.catch(() => undefined);
  if (options.body !== undefined) request.write(options.body);
  return {
    request,
    response,
    next: () =>
      queue.length > 0
        ? Promise.resolve(queue.shift())
        : new Promise((resolve) => {
            waiting.push(resolve);
          }),
  };
}
