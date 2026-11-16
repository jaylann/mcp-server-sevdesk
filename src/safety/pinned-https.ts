/**
 * One HTTPS GET to an address checked beforehand (`./public-address.ts`), for the requests this
 * server sends to a host someone else names: client metadata documents in OAuth mode
 * (`src/http/oauth/cimd.ts`) and receipt files from an https link (`./url-files.ts`).
 *
 * - The connection goes to the checked address: `https.request` with a `lookup` that answers
 *   with it, so Node never resolves the name again (no DNS rebinding between check and connect).
 *   SNI, the `Host` header and the certificate check use the host name.
 * - No agent (no pooled connection, no shared state), no cookies, no credentials: the request
 *   carries `Accept` and `User-Agent` from the caller and nothing else of its own (Node adds
 *   `Host` and `Connection`).
 * - Redirects and errors are never followed or read: any status but 200 resolves at once with the
 *   headers and an empty body; the caller decides.
 * - The body is capped: a declared `Content-Length` over the cap, and a body that grows past it,
 *   reject with the caller's `tooLarge` error. The TLS handshake and the whole request have their
 *   own timeouts; a signal cancels the request.
 * - Only the headers the caller names are kept, in an object without a prototype: header names
 *   come from the remote host and must never become arbitrary property names.
 *
 * Rejections other than `tooLarge` are plain errors whose messages may name addresses or carry
 * text from the network: callers map them to their own trusted text and never show them.
 */
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

import type { ResolvedAddress } from "./public-address.js";

/** One GET to an already checked address. */
export interface PinnedGetRequest {
  /** Host name: sent as `Host` and SNI, and checked against the certificate. */
  readonly hostname: string;
  /** What the request line carries: the path and, where the caller allows one, the query. */
  readonly path: string;
  /** The checked address to connect to. */
  readonly address: ResolvedAddress;
  /** Largest body read for this request; defaults to {@link PinnedGetOptions.maxBytes}. */
  readonly maxBytes?: number | undefined;
  /** Cancels the request: the socket is destroyed and the promise rejects. */
  readonly signal?: AbortSignal | undefined;
}

export interface PinnedGetResponse {
  readonly status: number;
  /** The headers named in {@link PinnedGetOptions.readHeaders}, lower-cased. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The body of a 200; empty for every other status. */
  readonly body: Buffer;
}

/** Performs one request under the rules of the module comment. */
export type PinnedGet = (request: PinnedGetRequest) => Promise<PinnedGetResponse>;

export interface PinnedGetOptions {
  /** The `Accept` header. */
  readonly accept: string;
  /** The `User-Agent` header. */
  readonly userAgent: string;
  /** Lower-cased names of the response headers the caller reads; every other one is dropped. */
  readonly readHeaders: readonly string[];
  /** Largest body read when the request names no limit of its own. */
  readonly maxBytes: number;
  /** The error a body over the limit rejects with (trusted text of the caller). */
  readonly tooLarge: () => Error;
  /** Until the TLS handshake completes. */
  readonly connectTimeoutMs: number;
  /** Until the whole body is read. */
  readonly totalTimeoutMs: number;
  /** Tests only: the port to connect to (default 443) and extra trusted CAs. */
  readonly port?: number | undefined;
  readonly ca?: string | Buffer | undefined;
}

/** The production {@link PinnedGet}: `https.request` pinned to the checked address. */
export function createPinnedGet(options: PinnedGetOptions): PinnedGet {
  return (target) =>
    new Promise<PinnedGetResponse>((resolve, reject) => {
      const maxBytes = target.maxBytes ?? options.maxBytes;
      const { signal } = target;
      if (signal?.aborted === true) {
        reject(abortReason(signal));
        return;
      }
      const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all === true) {
          callback(null, [{ address: target.address.address, family: target.address.family }]);
        } else {
          callback(null, target.address.address, target.address.family);
        }
      };
      let settled = false;
      const request = httpsRequest({
        host: target.hostname,
        servername: target.hostname,
        port: options.port ?? 443,
        path: target.path,
        method: "GET",
        headers: { Accept: options.accept, "User-Agent": options.userAgent },
        lookup: pinned,
        agent: false,
        maxHeaderSize: 16 * 1024,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      });
      const totalTimer = setTimeout(() => {
        finish(new Error("timeout"));
      }, options.totalTimeoutMs);
      const connectTimer = setTimeout(() => {
        finish(new Error("connect timeout"));
      }, options.connectTimeoutMs);
      const onAbort = (): void => {
        finish(abortReason(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      function finish(error: Error | undefined, response?: PinnedGetResponse): void {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        clearTimeout(connectTimer);
        signal?.removeEventListener("abort", onAbort);
        if (error !== undefined) {
          request.destroy();
          reject(error);
        } else if (response !== undefined) {
          resolve(response);
        }
      }
      request.once("socket", (socket) => {
        socket.once("secureConnect", () => {
          clearTimeout(connectTimer);
        });
      });
      request.once("error", (error) => {
        finish(error);
      });
      request.once("response", (response) => {
        const status = response.statusCode ?? 0;
        const headers: Record<string, string | undefined> = Object.create(null) as Record<
          string,
          string | undefined
        >;
        for (const name of options.readHeaders) {
          const value = response.headers[name];
          if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
        }
        if (status !== 200) {
          // Redirects and errors are not followed or read.
          response.destroy();
          finish(undefined, { status, headers, body: Buffer.alloc(0) });
          return;
        }
        if (Number(headers["content-length"] ?? "0") > maxBytes) {
          response.destroy();
          finish(options.tooLarge());
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            finish(options.tooLarge());
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          finish(undefined, { status, headers, body: Buffer.concat(chunks) });
        });
        response.once("error", (error) => {
          finish(error);
        });
      });
      request.end();
    });
}

/** The error a cancelled request rejects with: the signal's reason when it is an error. */
function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error("aborted");
}
