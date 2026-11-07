/**
 * Scripted `fetch` and clock for client tests. The fake fetch records every request and answers
 * with queued replies in order; an unexpected extra request fails the test loudly. The fake clock
 * makes pacing and retry backoff instant while recording every requested delay.
 */
import type { Sleep } from "../../src/sevdesk/pacing.js";

interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly signal: AbortSignal | undefined;
  readonly redirect: string | undefined;
}

/**
 * One scripted answer: a `Response`, `{ throws }` to reject with an error (e.g. a network
 * failure), `"hang"` to wait until the request is aborted, or a function for anything dynamic.
 */
export type FakeReply =
  | Response
  | { readonly throws: unknown }
  | "hang"
  | ((request: RecordedRequest) => Response | Promise<Response>);

export interface FakeFetch {
  readonly fetch: typeof fetch;
  readonly requests: RecordedRequest[];
  /** Appends replies to the queue. */
  reply(...replies: FakeReply[]): void;
  /** Replies not consumed yet. */
  readonly pending: number;
}

export function createFakeFetch(...initial: FakeReply[]): FakeFetch {
  const queue: FakeReply[] = [...initial];
  const requests: RecordedRequest[] = [];

  const fakeFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const request: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ?? undefined,
      signal: init?.signal ?? undefined,
      redirect: init?.redirect,
    };
    requests.push(request);

    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error(`Unexpected request: ${request.method} ${url.href}`));
    }
    if (next instanceof Response) return Promise.resolve(next);
    if (next === "hang") return hang(request.signal);
    if (typeof next === "function") return Promise.resolve(next(request));
    return Promise.reject(toError(next.throws));
  };

  return {
    fetch: fakeFetch,
    requests,
    reply(...replies) {
      queue.push(...replies);
    },
    get pending() {
      return queue.length;
    },
  };
}

/** A JSON response. */
export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** sevDesk's success envelope `{"objects": …}` (plus `total` when given). */
export function envelope(objects: unknown, total?: string): Response {
  return jsonResponse(total === undefined ? { objects } : { total, objects });
}

/** sevDesk's error body: `{"objects":null,"error":{"message",…,"exceptionUUID"}}`. */
export function sevdeskErrorResponse(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(
    {
      objects: null,
      error: {
        message,
        code: null,
        data: null,
        exceptionUUID: "4f1c2d3e-0000-4000-8000-000000000001",
      },
    },
    status,
    headers,
  );
}

/** What undici's fetch rejects with when the connection fails. */
export function networkError(code = "ECONNREFUSED"): TypeError {
  const cause = Object.assign(new Error(`connect ${code} 127.0.0.1:443`), { code });
  return new TypeError("fetch failed", { cause });
}

export interface FakeClock {
  readonly now: () => number;
  /** Records the delay, advances the clock, resolves immediately (rejects if already aborted). */
  readonly sleep: Sleep;
  readonly sleeps: number[];
}

export const FAKE_EPOCH = Date.parse("2026-11-07T12:00:00Z");

export function createFakeClock(start = FAKE_EPOCH): FakeClock {
  let time = start;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: (ms, signal) => {
      if (signal?.aborted === true) return Promise.reject(toError(signal.reason));
      sleeps.push(ms);
      time += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

function hang(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(toError(signal.reason));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(toError(signal.reason));
      },
      { once: true },
    );
  });
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
