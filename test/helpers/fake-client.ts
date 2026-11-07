/**
 * An in-memory {@link SevdeskClient} for unit tests: answers from a route table (method + path +
 * optional query subset → fixture, raw body or thrown {@link SevdeskError}) and records every call.
 *
 * It mirrors the real client's contract where tests depend on it:
 * - paths are checked with `assertSafePath` (ids validated) before anything is answered;
 * - `list` requires `limit` 1–1000 and `offset` ≥ 0, refuses `limit`/`offset`/`countAll` in the
 *   query, and records the query it would send (`limit`, `offset`, `countAll: true` included);
 * - a fixture without `total` is treated as the whole collection and paged by `limit`/`offset`
 *   with `total` = its length; a fixture with `total` is a recorded single page and returned as is
 *   (`total: null` simulates a page without a usable count: `Page.total` is then `undefined`);
 * - `listAll` pages until an empty page and asks for one row beyond `max` to detect truncation.
 */
import { readFileSync } from "node:fs";

import { z } from "zod";

import { type Config, loadConfig } from "../../src/config.js";
import { parseTotal, readEnvelope } from "../../src/sevdesk/envelope.js";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import { assertSafePath } from "../../src/sevdesk/paths.js";
import type {
  CollectedList,
  HttpMethod,
  ListAllOptions,
  ListOptions,
  Page,
  QueryValue,
  SevdeskClient,
  SevdeskRequest,
} from "../../src/sevdesk/types.js";
import type { ToolContext } from "../../src/tools/types.js";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const provenanceSchema = z.strictObject({
  source: z.enum(["spec", "community", "recorded"]),
  ref: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  systemVersion: z.enum(["1.0", "2.0"]),
  note: z.string().optional(),
});

const fixtureSchema = z.strictObject({
  _provenance: provenanceSchema,
  status: z.number().int().min(200).max(299),
  body: z.unknown(),
});

export type Fixture = z.output<typeof fixtureSchema>;

/**
 * Loads `test/fixtures/<relativePath>` and validates its format (provenance required, see
 * `test/fixtures/README.md`).
 */
export function loadFixture(relativePath: string): Fixture {
  const url = new URL(`../fixtures/${relativePath}`, import.meta.url);
  return fixtureSchema.parse(JSON.parse(readFileSync(url, "utf8")));
}

// ---------------------------------------------------------------------------------------------
// Routes and calls
// ---------------------------------------------------------------------------------------------

type FakeResponse =
  /** A fixture file below `test/fixtures/`, e.g. `"contacts/contact-1001.json"`. */
  | { readonly fixture: string }
  /** A raw response body (the full envelope, e.g. `{ objects: [...] }`). */
  | { readonly body: unknown }
  /** Thrown as is, e.g. `new SevdeskError({ kind: "not_found", ... })`. */
  | { readonly error: SevdeskError }
  /** For `download`. */
  | { readonly bytes: Uint8Array; readonly contentType?: string };

export interface FakeRoute {
  /** Defaults to GET. */
  readonly method?: HttpMethod;
  readonly path: string;
  /**
   * Query parameters the request must contain (compared as strings; booleans as `1`/`0`). Other
   * parameters are allowed. List paging parameters are not matched.
   */
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly response: FakeResponse;
}

export interface RecordedCall {
  readonly operation: "request" | "list" | "download";
  readonly method: HttpMethod;
  readonly path: string;
  /** The query as the real client would send it, paging parameters included. */
  readonly query: Readonly<Record<string, QueryValue>>;
  readonly sideEffect: boolean;
  /** The JSON body of a `request` (writes), exactly as passed to the client. */
  readonly body?: unknown;
  /** The tier the request declared (stamped by the tier-scoped client for writes). */
  readonly tier?: SevdeskRequest["tier"];
}

const MIN_LIMIT = 1;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;
const DEFAULT_LIST_ALL_PAGE_SIZE = 500;
const RESERVED_LIST_KEYS = ["limit", "offset", "countAll"] as const;

export class FakeSevdeskClient implements SevdeskClient {
  readonly calls: RecordedCall[] = [];
  private readonly routes: readonly FakeRoute[];

  constructor(routes: readonly FakeRoute[]) {
    this.routes = routes;
  }

  /** HTTP methods of all recorded calls. */
  methods(): HttpMethod[] {
    return this.calls.map((call) => call.method);
  }

  /** Recorded calls to `path` (exact match). */
  callsTo(path: string): RecordedCall[] {
    return this.calls.filter((call) => call.path === path);
  }

  request(request: SevdeskRequest): Promise<unknown> {
    return Promise.resolve().then(() => {
      checkRequest(request.path, request.signal);
      const query = request.query ?? {};
      this.record("request", request.method, request.path, query, request.sideEffect ?? false, {
        body: request.body,
        tier: request.tier,
      });
      return this.envelopeFor(request.method, request.path, query).objects;
    });
  }

  list(
    path: string,
    query?: Readonly<Record<string, QueryValue>>,
    options: ListOptions = {},
  ): Promise<Page> {
    return Promise.resolve().then(() => {
      checkRequest(path, options.signal);
      const limit = options.limit ?? DEFAULT_LIMIT;
      const offset = options.offset ?? 0;
      if (!Number.isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
        throw localError(`limit must be a whole number from ${MIN_LIMIT} to ${MAX_LIMIT}.`);
      }
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw localError("offset must be a whole number of 0 or more.");
      }
      for (const key of RESERVED_LIST_KEYS) {
        if (query !== undefined && Object.hasOwn(query, key)) {
          throw localError(`Pass ${key} through the list options, not the query.`);
        }
      }
      this.record("list", "GET", path, { ...query, limit, offset, countAll: true }, false);

      const envelope = this.envelopeFor("GET", path, query ?? {});
      if (!Array.isArray(envelope.objects)) {
        throw new SevdeskError({
          kind: "unexpected_response",
          message: "sevDesk returned an unexpected format: expected a list of objects.",
        });
      }
      const all = envelope.objects as unknown[];
      if (envelope.total !== undefined) {
        return { items: all, total: parseTotal(envelope.total) };
      }
      return { items: all.slice(offset, offset + limit), total: all.length };
    });
  }

  async listAll(
    path: string,
    query: Readonly<Record<string, QueryValue>> | undefined,
    options: ListAllOptions,
  ): Promise<CollectedList> {
    const { max } = options;
    const pageSize = options.pageSize ?? DEFAULT_LIST_ALL_PAGE_SIZE;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw localError("max must be a whole number of 1 or more.");
    }
    const items: unknown[] = [];
    let total: number | undefined;
    for (;;) {
      const limit = Math.min(pageSize, max - items.length + 1);
      const page = await this.list(path, query, {
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

  download(
    request: SevdeskRequest,
  ): Promise<{ body: Uint8Array; contentType: string | undefined }> {
    return Promise.resolve().then(() => {
      checkRequest(request.path, request.signal);
      const query = request.query ?? {};
      this.record("download", request.method, request.path, query, request.sideEffect ?? false, {
        tier: request.tier,
      });
      const response = this.route(request.method, request.path, query).response;
      if ("error" in response) throw response.error;
      if (!("bytes" in response)) {
        throw new Error(`FakeSevdeskClient: route ${request.path} has no bytes for download`);
      }
      return { body: response.bytes, contentType: response.contentType };
    });
  }

  private record(
    operation: RecordedCall["operation"],
    method: HttpMethod,
    path: string,
    query: Readonly<Record<string, QueryValue>>,
    sideEffect: boolean,
    extra: { readonly body?: unknown; readonly tier?: SevdeskRequest["tier"] } = {},
  ): void {
    this.calls.push({
      operation,
      method,
      path,
      query,
      sideEffect,
      ...(extra.body === undefined ? {} : { body: extra.body }),
      ...(extra.tier === undefined ? {} : { tier: extra.tier }),
    });
  }

  /** Recorded calls that change data (any non-GET, or a GET declared as a side effect). */
  writes(): RecordedCall[] {
    return this.calls.filter((call) => call.method !== "GET" || call.sideEffect);
  }

  private route(
    method: HttpMethod,
    path: string,
    query: Readonly<Record<string, QueryValue>>,
  ): FakeRoute {
    const match = this.routes.find(
      (route) =>
        (route.method ?? "GET") === method &&
        route.path === path &&
        Object.entries(route.query ?? {}).every(
          ([key, expected]) => serialize(query[key]) === serialize(expected),
        ),
    );
    if (match === undefined) {
      throw new Error(`FakeSevdeskClient: no route for ${method} ${path} ${JSON.stringify(query)}`);
    }
    return match;
  }

  private envelopeFor(
    method: HttpMethod,
    path: string,
    query: Readonly<Record<string, QueryValue>>,
  ): { objects: unknown; total: unknown } {
    const response = this.route(method, path, query).response;
    if ("error" in response) throw response.error;
    if ("bytes" in response) {
      throw new Error(`FakeSevdeskClient: route ${path} only serves downloads`);
    }
    const body = "fixture" in response ? loadFixture(response.fixture).body : response.body;
    const envelope = readEnvelope(body);
    if (envelope === undefined) {
      throw new SevdeskError({
        kind: "unexpected_response",
        message: "sevDesk returned an unexpected format: the response has no objects member.",
      });
    }
    return { objects: envelope.objects, total: envelope.total };
  }
}

function checkRequest(path: string, signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new SevdeskError({ kind: "aborted", message: "The request was cancelled." });
  }
  assertSafePath(path);
}

function localError(message: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message: `Invalid request: ${message}` });
}

function serialize(value: QueryValue): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

// ---------------------------------------------------------------------------------------------
// Tool context
// ---------------------------------------------------------------------------------------------

/** A syntactically valid, fake sevDesk token. */
const TEST_TOKEN = "0123456789abcdef0123456789abcdef";

/** A config built the same way as at startup, from `SEVDESK_*` variables (token preset). */
function testConfig(env: Readonly<Record<string, string>> = {}): Config {
  return loadConfig({ SEVDESK_API_TOKEN: TEST_TOKEN, ...env });
}

/** A {@link ToolContext} for calling `tool.handler(args, ctx)` directly. */
export function testContext(
  client: SevdeskClient,
  env: Readonly<Record<string, string>> = {},
): ToolContext {
  return {
    client,
    config: testConfig(env),
    signal: new AbortController().signal,
    progress: () => Promise.resolve(),
  };
}
