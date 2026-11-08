/**
 * The sevDesk HTTP client: auth header, pacing, timeouts, cancellation, the write gate, GET-only
 * retries and error classification. Domain code talks to sevDesk only through the
 * {@link SevdeskClient} interface this module implements.
 *
 * Safety invariants:
 * - Requests that change data (any non-GET, GETs marked `sideEffect`, and the state-changing GET
 *   endpoints recognized by `resolveGetSafety`) are refused before any network activity unless
 *   writes are enabled: not read-only, not dry-run, the request's declared `tier` allowed, and
 *   that tier covers the endpoint's minimum tier (`minimumWriteTier`: e.g. `sendBy` needs
 *   `commit`, `sendViaEmail` needs `external`), so a write tool cannot finalize or send.
 * - A `getPdf` read always carries the literal `preventSendBy=true`, so a preview never marks a
 *   document as sent.
 * - Only side-effect-free GETs are retried. A retried POST can create a second invoice.
 * - The token is sent only in the `Authorization` header; redirects are not followed, so it never
 *   reaches another origin, and it is redacted from all upstream text kept on errors.
 */
import type { Config } from "../config.js";
import { isWriteTier, tierCovers, type WriteTier } from "../safety/tiers.js";
import { type Envelope, expectArray, parseTotal, readEnvelope } from "./envelope.js";
import {
  type ErrorContext,
  errorFromResponse,
  messageForKind,
  SevdeskError,
  type SevdeskErrorKind,
  unexpectedResponse,
} from "./errors.js";
import { createPacer, realSleep, type Sleep } from "./pacing.js";
import { assertSafePath, minimumWriteTier, resolveGetSafety } from "./paths.js";
import type {
  CollectedList,
  ListAllOptions,
  ListOptions,
  Page,
  QueryValue,
  SevdeskClient,
  SevdeskRequest,
} from "./types.js";

/** The configuration slice the client needs. */
export type SevdeskClientConfig = Pick<
  Config,
  | "token"
  | "baseUrl"
  | "allowedTiers"
  | "readOnly"
  | "dryRun"
  | "requestsPerSecond"
  | "timeoutMs"
  | "userAgent"
>;

interface EventBase {
  readonly method: string;
  readonly path: string;
  /** 1-based attempt number. */
  readonly attempt: number;
}

/** An attempt is about to be sent (after pacing). */
interface RequestEvent extends EventBase {
  readonly type: "request";
}

/** An attempt got a 2xx response and its body was read. */
interface ResponseEvent extends EventBase {
  readonly type: "response";
  readonly status: number;
  readonly durationMs: number;
}

/** An attempt failed; `status` is set when sevDesk answered. */
interface FailureEvent extends EventBase {
  readonly type: "failure";
  readonly kind: SevdeskErrorKind;
  readonly status: number | undefined;
  readonly durationMs: number;
}

/** A failed side-effect-free GET will be retried after `delayMs`. */
interface RetryEvent extends EventBase {
  readonly type: "retry";
  readonly kind: SevdeskErrorKind;
  readonly delayMs: number;
}

/**
 * Diagnostics emitted by the client. Never contains headers, bodies, query values or the token,
 * so it is safe to log.
 */
export type SevdeskClientEvent = RequestEvent | ResponseEvent | FailureEvent | RetryEvent;

/** Injectable collaborators, for tests and diagnostics. */
export interface SevdeskClientDeps {
  readonly fetch?: typeof fetch;
  readonly sleep?: Sleep;
  /** Wall clock in epoch milliseconds; only used to read HTTP-date `Retry-After` headers. */
  readonly now?: () => number;
  /**
   * Monotonic milliseconds (default `performance.now()`) for pacing and durations, so a wall
   * clock jumping backwards cannot stall requests.
   */
  readonly monotonicNow?: () => number;
  /** Uniform in [0, 1), used for retry jitter. */
  readonly random?: () => number;
  /** Diagnostics hook; exceptions it throws are ignored. */
  readonly onEvent?: (event: SevdeskClientEvent) => void;
}

/** Attempts per side-effect-free GET, including the first one. */
const MAX_ATTEMPTS = 3;
/** Exponential backoff with full jitter: `random() * min(cap, base * 2^(attempt - 1))`. */
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8_000;
/** A `Retry-After` header is honored but clamped to this range. */
const RETRY_AFTER_MIN_MS = 250;
const RETRY_AFTER_MAX_MS = 30_000;
/** sevDesk's limit range. Omitting `limit` silently truncates at 100, so it is always sent. */
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_LIST_ALL_PAGE_SIZE = 500;
/** Maximum requests in flight per client. */
const MAX_CONCURRENCY = 4;

const RESERVED_LIST_KEYS = ["limit", "offset", "countAll"] as const;

type WriteGateConfig = Pick<SevdeskClientConfig, "allowedTiers" | "readOnly" | "dryRun">;

/**
 * Why a request of `tier` that changes data is refused under `config`, or `undefined` when it is
 * allowed. Checked in this order, each with its own wording: read-only mode, dry-run mode, a
 * missing (or non-write) tier, which is a programming error, a tier below the endpoint's
 * `required` minimum (also a programming error: the tool has the wrong tier), and a tier not
 * enabled in `SEVDESK_ALLOW`. The text is trusted and names the setting to change.
 */
export function writeBlockReason(
  config: WriteGateConfig,
  tier: WriteTier | undefined,
  required: WriteTier = "write",
): string | undefined {
  if (config.readOnly) return "read-only mode is on (SEVDESK_READ_ONLY)";
  if (config.dryRun) return "dry-run mode is on (SEVDESK_DRY_RUN)";
  // `tier` is typed, but a cast elsewhere could still smuggle in "read".
  if (tier === undefined || !isWriteTier(tier)) {
    return "internal error: a request that changes data did not declare its tier";
  }
  if (!tierCovers(tier, required)) {
    return (
      `internal error: this endpoint needs at least the ${required} tier, but the calling tool ` +
      `has the ${tier} tier`
    );
  }
  if (!config.allowedTiers.has(tier)) {
    return (
      `it needs the ${tier} tier, which is not enabled (set SEVDESK_ALLOW=${tier}, ` +
      "comma-separated with any other tiers you need)"
    );
  }
  return undefined;
}

/** Whether `config` lets a request of `tier` that changes data through. */
export function writesAllowed(config: WriteGateConfig, tier: WriteTier | undefined): boolean {
  return writeBlockReason(config, tier) === undefined;
}

/**
 * Parses a `Retry-After` header (delay seconds or HTTP-date) into milliseconds, clamped to
 * 250 ms–30 s. `undefined` when absent or invalid.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  let delayMs: number;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    delayMs = Number(trimmed) * 1000;
  } else {
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return undefined;
    delayMs = date - nowMs;
  }
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, delayMs));
}

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SevdeskError; readonly retryAfterMs?: number };

interface Prepared {
  readonly method: string;
  readonly path: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | FormData | undefined;
  readonly signal: AbortSignal | undefined;
  /** Only side-effect-free GETs. */
  readonly retryable: boolean;
  readonly context: ErrorContext;
}

/**
 * Creates the sevDesk client. One instance per account/token; it owns that account's pacing
 * (token bucket at `requestsPerSecond`, at most 4 requests in flight). `timeoutMs` applies per
 * attempt (fetch plus reading the body); the caller's signal also covers pacing and backoff waits.
 * GETs are retried at most twice (3 attempts) on rate_limited/server/network/timeout, with full
 * jitter backoff (base 500 ms, cap 8 s) or the server's `Retry-After`.
 */
export function createSevdeskClient(
  config: SevdeskClientConfig,
  deps: SevdeskClientDeps = {},
): SevdeskClient {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const wallNow = deps.now ?? Date.now;
  const now = deps.monotonicNow ?? (() => performance.now());
  const random = deps.random ?? Math.random;
  const pacer = createPacer({
    requestsPerSecond: config.requestsPerSecond,
    maxConcurrency: MAX_CONCURRENCY,
    now,
    sleep,
  });
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  function emit(event: SevdeskClientEvent): void {
    try {
      deps.onEvent?.(event);
    } catch {
      // Diagnostics must never break a request.
    }
  }

  function prepare(request: SevdeskRequest, accept: string): Prepared {
    const { method, path } = request;
    assertSafePath(path);
    const context: ErrorContext = { method, path, secrets: [config.token] };

    const hasBody = request.body !== undefined;
    const hasForm = request.form !== undefined;
    if (hasBody && hasForm) {
      throw localError(context, "Pass either a JSON body or a form, not both.");
    }
    if (method === "GET" && (hasBody || hasForm)) {
      throw localError(context, "A GET request cannot have a body.");
    }

    // GETs are classified by endpoint too, so a forgotten `sideEffect` flag cannot send an
    // invoice; a getPdf read gets `preventSendBy=true` here.
    const safety =
      method === "GET"
        ? resolveGetSafety(path, request.query, request.sideEffect === true)
        : undefined;
    const changesData = safety === undefined || safety.sideEffect;
    if (changesData) {
      const reason = writeBlockReason(
        config,
        request.tier,
        minimumWriteTier(path, request.query, request.body),
      );
      if (reason !== undefined) {
        const effect = safety?.sideEffect === true ? ` (${safety.effect})` : "";
        throw new SevdeskError({
          kind: "blocked",
          message:
            `Blocked before sending: ${method} ${path} changes data in sevDesk${effect}, ` +
            `but ${reason}. Nothing was sent.`,
          method,
          path,
        });
      }
    }

    const url = new URL(`${baseUrl}${path}`);
    url.search = buildQuery(safety === undefined ? request.query : safety.query, context);

    const headers = new Headers({
      Authorization: config.token,
      "User-Agent": config.userAgent,
      Accept: accept,
    });
    let body: string | FormData | undefined;
    if (hasBody) {
      headers.set("Content-Type", "application/json");
      body = serializeJson(request.body, context);
    } else if (request.form !== undefined) {
      body = request.form;
    }

    return {
      method,
      path,
      url,
      headers,
      body,
      signal: request.signal,
      retryable: !changesData,
      context,
    };
  }

  async function send<T>(
    request: SevdeskRequest,
    accept: string,
    readSuccess: (response: Response, context: ErrorContext) => Promise<T>,
  ): Promise<T> {
    const prepared = prepare(request, accept);
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await attemptOnce(prepared, attempt, readSuccess);
      if (outcome.ok) return outcome.value;
      const { error } = outcome;
      const cancelled = prepared.signal?.aborted === true;
      if (!prepared.retryable || !error.retryableForReads || attempt >= MAX_ATTEMPTS || cancelled) {
        throw error;
      }

      const delayMs =
        outcome.retryAfterMs ??
        Math.round(random() * Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1)));
      emit({
        type: "retry",
        method: prepared.method,
        path: prepared.path,
        attempt,
        kind: error.kind,
        delayMs,
      });
      try {
        await sleep(delayMs, prepared.signal);
      } catch (cause) {
        throw cancellationError(prepared.context, prepared.signal, cause);
      }
    }
  }

  async function attemptOnce<T>(
    prepared: Prepared,
    attempt: number,
    readSuccess: (response: Response, context: ErrorContext) => Promise<T>,
  ): Promise<Outcome<T>> {
    const { method, path, context } = prepared;
    const callerSignal = prepared.signal;

    let release: () => void;
    try {
      release = await pacer.acquire(callerSignal);
    } catch (cause) {
      throw cancellationError(context, callerSignal, cause);
    }

    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const signal =
      callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal]);
    const started = now();
    emit({ type: "request", method, path, attempt });

    const fail = (error: SevdeskError, retryAfterMs?: number): Outcome<T> => {
      emit({
        type: "failure",
        method,
        path,
        attempt,
        kind: error.kind,
        status: error.status,
        durationMs: now() - started,
      });
      return retryAfterMs === undefined ? { ok: false, error } : { ok: false, error, retryAfterMs };
    };

    try {
      const init: RequestInit = { method, headers: prepared.headers, signal, redirect: "manual" };
      if (prepared.body !== undefined) init.body = prepared.body;
      const response = await fetchImpl(prepared.url, init);
      const { status } = response;

      if (status >= 200 && status < 300) {
        const value = await readSuccess(response, context);
        emit({ type: "response", method, path, attempt, status, durationMs: now() - started });
        return { ok: true, value };
      }

      const text = await response.text();
      return fail(
        errorFromResponse(status, text, context),
        parseRetryAfter(response.headers.get("retry-after"), wallNow()),
      );
    } catch (cause) {
      if (cause instanceof SevdeskError) return fail(cause);
      if (callerSignal?.aborted === true) {
        return fail(cancellationError(context, callerSignal, cause));
      }
      if (timeoutSignal.aborted || errorName(cause) === "TimeoutError") {
        return fail(
          new SevdeskError({
            kind: "timeout",
            message:
              `sevDesk did not answer within ${config.timeoutMs} ms. ` +
              "Raise SEVDESK_TIMEOUT_MS if this persists.",
            method,
            path,
            cause,
          }),
        );
      }
      if (errorName(cause) === "AbortError") {
        return fail(cancellationError(context, undefined, cause));
      }
      return fail(
        new SevdeskError({
          kind: "network",
          message: messageForKind("network"),
          method,
          path,
          cause,
        }),
      );
    } finally {
      release();
    }
  }

  async function sendJson(request: SevdeskRequest): Promise<Envelope> {
    return send(request, "application/json", readJsonEnvelope);
  }

  async function list(
    path: string,
    query?: Readonly<Record<string, QueryValue>>,
    options: ListOptions = {},
  ): Promise<Page> {
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    const offset = options.offset ?? 0;
    const context: ErrorContext = { method: "GET", path, secrets: [config.token] };
    if (!Number.isInteger(limit) || limit < MIN_PAGE_SIZE || limit > MAX_PAGE_SIZE) {
      throw localError(
        context,
        `limit must be a whole number from ${MIN_PAGE_SIZE} to ${MAX_PAGE_SIZE}.`,
      );
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw localError(context, "offset must be a whole number of 0 or more.");
    }
    for (const key of RESERVED_LIST_KEYS) {
      if (query !== undefined && Object.hasOwn(query, key)) {
        throw localError(context, `Pass ${key} through the list options, not the query.`);
      }
    }

    const envelope = await sendJson({
      method: "GET",
      path,
      query: { ...query, limit, offset, countAll: true },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return { items: expectArray(envelope.objects), total: parseTotal(envelope.total) };
  }

  async function listAll(
    path: string,
    query: Readonly<Record<string, QueryValue>> | undefined,
    options: ListAllOptions,
  ): Promise<CollectedList> {
    const { max } = options;
    const pageSize = options.pageSize ?? DEFAULT_LIST_ALL_PAGE_SIZE;
    const context: ErrorContext = { method: "GET", path, secrets: [config.token] };
    if (!Number.isSafeInteger(max) || max < 1) {
      throw localError(context, "max must be a whole number of 1 or more.");
    }
    if (!Number.isInteger(pageSize) || pageSize < MIN_PAGE_SIZE || pageSize > MAX_PAGE_SIZE) {
      throw localError(
        context,
        `pageSize must be a whole number from ${MIN_PAGE_SIZE} to ${MAX_PAGE_SIZE}.`,
      );
    }

    const items: unknown[] = [];
    let total: number | undefined;
    // A short page is not proof of the end (sevDesk can return fewer rows than asked for), so
    // paging stops only at an empty page. One row beyond `max` is requested to detect truncation.
    for (;;) {
      const limit = Math.min(pageSize, max - items.length + 1);
      const page = await list(path, query, {
        limit,
        offset: items.length,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      total = page.total ?? total;
      if (page.items.length === 0) return { items, total, truncated: false };
      items.push(...page.items);
      if (items.length > max) {
        items.length = max;
        options.onProgress?.(items.length, total);
        return { items, total, truncated: true };
      }
      options.onProgress?.(items.length, total);
    }
  }

  return {
    async request(request) {
      const envelope = await sendJson(request);
      return envelope.objects;
    },
    list,
    listAll,
    async download(request) {
      const maxBytes = request.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
      return send(request, "*/*", async (response, context) => ({
        body: await readCappedBody(response, maxBytes, (received) =>
          unexpectedResponse(
            response.status,
            "",
            context,
            `the body is larger than ${String(maxBytes)} bytes (stopped after ${String(received)}).`,
          ),
        ),
        contentType: response.headers.get("content-type") ?? undefined,
      }));
    },
  };
}

/** Default cap of {@link SevdeskClient.download} bodies (see `SevdeskRequest.maxBytes`). */
const DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Reads a response body as bytes, at most `maxBytes`: streams it and cancels the stream as soon
 * as it grows past the cap (then throws `tooLarge(received)`), so a huge body never sits in
 * memory as a whole.
 */
export async function readCappedBody(
  response: Response,
  maxBytes: number,
  tooLarge: (received: number) => Error,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge(declared);
  }
  if (response.body === null) return new Uint8Array();
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const value: Uint8Array = chunk.value;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(received);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Reads a 2xx JSON response into its envelope. An empty 204 yields `objects: undefined`. Empty
 * bodies with other statuses, non-JSON, a missing `objects` member, and `objects: null` next to an
 * `error` member are `unexpected_response` errors.
 */
async function readJsonEnvelope(response: Response, context: ErrorContext): Promise<Envelope> {
  const { status } = response;
  const text = await response.text();
  if (text.trim().length === 0) {
    if (status === 204) return { objects: undefined, total: undefined };
    throw unexpectedResponse(status, text, context, "the body is empty.");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw unexpectedResponse(status, text, context, "the body is not JSON.");
  }
  const envelope = readEnvelope(body);
  if (envelope === undefined) {
    throw unexpectedResponse(status, text, context, "the 'objects' member is missing.");
  }
  if (envelope.objects === null && hasErrorMember(body)) {
    throw unexpectedResponse(status, text, context, "it reports an error despite its status.");
  }
  return envelope;
}

function hasErrorMember(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const error: unknown = (body as Record<string, unknown>)["error"];
  return error !== undefined && error !== null;
}

/** Serializes query values: `undefined` is skipped, booleans become `1`/`0`. */
function buildQuery(
  query: Readonly<Record<string, QueryValue>> | undefined,
  context: ErrorContext,
): string {
  const params = new URLSearchParams();
  if (query === undefined) return "";
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (key.length === 0) throw localError(context, "Query parameter names must not be empty.");
    if (typeof value === "boolean") {
      params.append(key, value ? "1" : "0");
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw localError(context, "Query parameter values must be finite numbers.");
      }
      params.append(key, String(value));
    } else {
      params.append(key, value);
    }
  }
  return params.toString();
}

function serializeJson(body: unknown, context: ErrorContext): string {
  try {
    const json = JSON.stringify(body) as string | undefined;
    if (json !== undefined) return json;
  } catch {
    // Falls through to the error below.
  }
  throw localError(context, "The request body cannot be serialized as JSON.");
}

function localError(context: ErrorContext, detail: string): SevdeskError {
  return new SevdeskError({
    kind: "validation",
    message: `Invalid request: ${detail}`,
    method: context.method,
    path: context.path,
  });
}

/**
 * Error for a request stopped by the caller's signal: `timeout` when the signal carries a
 * `TimeoutError` (e.g. `AbortSignal.timeout(...)`, a deadline rather than a cancellation),
 * otherwise `aborted`.
 */
function cancellationError(
  context: ErrorContext,
  signal: AbortSignal | undefined,
  cause: unknown,
): SevdeskError {
  const deadline = errorName(signal?.reason) === "TimeoutError";
  return new SevdeskError({
    kind: deadline ? "timeout" : "aborted",
    message: deadline
      ? "sevDesk did not answer before the caller's deadline."
      : messageForKind("aborted"),
    method: context.method,
    path: context.path,
    cause,
  });
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}
