/**
 * Client wrappers the write framework hands to tools, so a tool cannot forget a safety rule:
 *
 * - {@link readOnlyClient} for `prepare` (and dry runs): every request that changes data is
 *   refused before it reaches the HTTP client.
 * - {@link tierScopedClient} for `execute`: stamps the tool's tier on every request that changes
 *   data and refuses requests to endpoints above that tier (`minimumWriteTier`); the HTTP client
 *   checks both again, plus the configuration.
 *
 * "Changes data" means what the HTTP client means: any non-GET, and GETs that
 * `resolveGetSafety` classifies as side effects (a `getPdf` without `preventSendBy`,
 * `sendByWithRender`, DATEV `enshrine` flags) or that declare `sideEffect`.
 */
import { tierCovers, type WriteTier } from "../safety/tiers.js";
import { SevdeskError } from "./errors.js";
import { minimumWriteTier, resolveGetSafety } from "./paths.js";
import type { SevdeskClient, SevdeskRequest } from "./types.js";

/** Whether `request` changes data in sevDesk (same rule as the HTTP client). */
export function changesData(request: SevdeskRequest): boolean {
  if (request.method !== "GET") {
    return true;
  }
  return resolveGetSafety(request.path, request.query, request.sideEffect === true).sideEffect;
}

/**
 * A view of `client` that refuses every request that changes data with a `blocked` error (nothing
 * is sent). `purpose` completes the sentence "… is not allowed while …", e.g. "preparing a
 * preview".
 */
export function readOnlyClient(client: SevdeskClient, purpose: string): SevdeskClient {
  const guard = (request: SevdeskRequest): void => {
    if (changesData(request)) {
      throw new SevdeskError({
        kind: "blocked",
        message:
          `Blocked before sending: ${request.method} ${request.path} changes data in sevDesk, ` +
          `which is not allowed while ${purpose}. Nothing was sent.`,
        method: request.method,
        path: request.path,
      });
    }
  };
  return {
    request: (request) =>
      Promise.resolve().then(() => {
        guard(request);
        return client.request(request);
      }),
    list: (path, query, options) => client.list(path, query, options),
    listAll: (path, query, options) => client.listAll(path, query, options),
    download: (request) =>
      Promise.resolve().then(() => {
        guard(request);
        return client.download(request);
      }),
  };
}

/**
 * A view of `client` that sets `tier` on every request that changes data. A request that already
 * carries a different tier is refused (tools never pass `tier` themselves), and so is a request
 * to an endpoint whose minimum tier `tier` does not cover (a `write` tool calling `sendBy`), the
 * same rule the HTTP client enforces, so tests with a fake client catch it too.
 */
export function tierScopedClient(client: SevdeskClient, tier: WriteTier): SevdeskClient {
  const stamp = (request: SevdeskRequest): SevdeskRequest => {
    if (!changesData(request)) {
      return request;
    }
    if (request.tier !== undefined && request.tier !== tier) {
      throw new SevdeskError({
        kind: "blocked",
        message:
          `Blocked before sending: ${request.method} ${request.path} declared the ${request.tier} ` +
          `tier inside a ${tier} tool. Nothing was sent.`,
        method: request.method,
        path: request.path,
      });
    }
    const required = minimumWriteTier(request.path, request.query);
    if (!tierCovers(tier, required)) {
      throw new SevdeskError({
        kind: "blocked",
        message:
          `Blocked before sending: ${request.method} ${request.path} needs at least the ` +
          `${required} tier, but it was called from a ${tier} tool. Nothing was sent.`,
        method: request.method,
        path: request.path,
      });
    }
    return { ...request, tier };
  };
  return {
    request: (request) => Promise.resolve().then(() => client.request(stamp(request))),
    list: (path, query, options) => client.list(path, query, options),
    listAll: (path, query, options) => client.listAll(path, query, options),
    download: (request) => Promise.resolve().then(() => client.download(stamp(request))),
  };
}
