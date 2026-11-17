/**
 * Downloads from https links (`src/safety/url-files.ts`) without the network: a resolver and a
 * transport that answer from tables and record every call, and the reader built from them. Pass
 * the reader to `localFileAccess(config, reader)` (or `remoteFileAccess`) for tool tests.
 */
import { vi } from "vitest";

import type { PinnedGetRequest, PinnedGetResponse } from "../../src/safety/pinned-https.js";
import type { ResolvedAddress } from "../../src/safety/public-address.js";
import { createUrlFileReader, type UrlFileReader } from "../../src/safety/url-files.js";

/** The host the fakes serve by default, and the allowlist that names it. */
export const LINK_HOST = "belege.example.com";
/**
 * A signed link: its path and query must never show up in a message, preview, result or log.
 * `SIGNATURE-7f3a` and `Rechnung-4711` are what tests look for.
 */
export const LINK = `https://${LINK_HOST}/portal/Rechnung-4711.pdf?sig=SIGNATURE-7f3a&exp=1`;
/** A public address (TEST-NET would be refused: it is documentation space). */
export const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 };

export const LINK_PDF = new TextEncoder().encode("%PDF-1.7\nBeleg 4711 per Link\n%%EOF");

/** A response of the fake transport. */
export function served(
  body: Uint8Array | string,
  headers: Readonly<Record<string, string>> = { "content-type": "application/pdf" },
  status = 200,
): PinnedGetResponse {
  return {
    status,
    headers: { ...headers },
    body: typeof body === "string" ? Buffer.from(body) : Buffer.from(body),
  };
}

/** A redirect of the fake transport. */
export function redirect(location: string, status = 302): PinnedGetResponse {
  return { status, headers: { location }, body: Buffer.alloc(0) };
}

export interface FakeLinksOptions {
  /** Default `[LINK_HOST]`. */
  readonly hosts?: readonly string[];
  /** Addresses per host name; a host that is missing does not resolve. Default: LINK_HOST public. */
  readonly addresses?: Readonly<Record<string, readonly ResolvedAddress[]>>;
  /** The answer to each request; default: {@link LINK_PDF} as `application/pdf`. */
  readonly respond?: (request: PinnedGetRequest) => PinnedGetResponse | Promise<PinnedGetResponse>;
  readonly timeoutMs?: number;
  readonly resolveTimeoutMs?: number;
}

export interface FakeLinks {
  readonly reader: UrlFileReader;
  /** Every host name the resolver was asked for, in order. */
  readonly resolved: string[];
  /** Every request the transport got, in order. */
  readonly requests: PinnedGetRequest[];
}

/** A reader over fakes (see the module comment). */
export function fakeLinks(options: FakeLinksOptions = {}): FakeLinks {
  const resolved: string[] = [];
  const requests: PinnedGetRequest[] = [];
  const addresses = options.addresses ?? { [LINK_HOST]: [PUBLIC] };
  const respond = options.respond ?? (() => served(LINK_PDF));
  const reader = createUrlFileReader({
    hosts: options.hosts ?? [LINK_HOST],
    resolve: vi.fn((hostname: string) => {
      resolved.push(hostname);
      const answer = addresses[hostname];
      return answer === undefined
        ? Promise.reject(new Error(`ENOTFOUND ${hostname}`))
        : Promise.resolve(answer);
    }),
    get: vi.fn(async (request: PinnedGetRequest) => {
      requests.push(request);
      return respond(request);
    }),
    timeoutMs: options.timeoutMs,
    resolveTimeoutMs: options.resolveTimeoutMs,
  });
  return { reader, resolved, requests };
}
