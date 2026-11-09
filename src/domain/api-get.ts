/**
 * The generic read behind `sevdesk_api_get`: one GET of a path the model chooses, for the parts
 * of the sevDesk API no curated tool covers (text templates, part units, attached documents, …).
 *
 * The path and the query come from the model, so every layer assumes they are hostile:
 *
 * 1. {@link genericGetRefusal} refuses state-changing, file and job endpoints and dangerous query
 *    keys (credentials, paging, `download`, `preventSendBy`, `enshrine…`, `useNextNumber`)
 *    before anything is sent; so does a query value that contains the configured token;
 * 2. the request goes through `readOnlyClient`, whose `resolveGetSafety` check refuses any GET
 *    that changes data even if (1) missed one, and then through the HTTP client, which refuses
 *    it again for lack of a declared tier;
 * 3. the answer is capped at {@link API_GET_MAX_BODY_BYTES} while streaming, must be JSON in
 *    sevDesk's `{objects: …}` envelope, and is cleaned like any untrusted sevDesk text: every
 *    string sanitized and capped, keys too, the token redacted, binary content (base64 files,
 *    thumbnails), `sevClient` echoes and nesting deeper than {@link MAX_DEPTH} removed and
 *    listed in `omittedFields`;
 * 4. the cleaned answer is cut to {@link API_GET_MAX_OUTPUT_BYTES} of JSON by dropping rows
 *    from the end (`omittedItems`, with `nextOffset` to continue), never silently.
 *
 * `limit`, `offset` and `countAll=true` are always sent (sevDesk silently cuts lists at 100
 * without a limit); single-record endpoints ignore them.
 */
import { MAX_UNTRUSTED_LENGTH, sanitizeUntrusted } from "../safety/fence.js";
import { redactSecrets } from "../safety/redact.js";
import { parseTotal, readEnvelope } from "../sevdesk/envelope.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { assertSafePath, genericGetRefusal } from "../sevdesk/paths.js";
import { readOnlyClient } from "../sevdesk/scoped-client.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { pageState } from "./paging.js";

/** Largest sevDesk answer read (1 MiB); a larger one is cut off while streaming and refused. */
export const API_GET_MAX_BODY_BYTES = 1024 * 1024;
/** Largest cleaned answer returned, as compact UTF-8 JSON of `objects` (about 100 KB). */
export const API_GET_MAX_OUTPUT_BYTES = 100_000;
/** Values nested deeper than this below `objects` are removed (and listed). */
const MAX_DEPTH = 12;
/** Object keys are untrusted text too; longer ones are cut like strings. */
const MAX_KEY_LENGTH = 200;
/** A string longer than this made only of base64 characters is binary content. */
const BINARY_MIN_LENGTH = 512;
/** At most this many patterns are listed in `omittedFields`. */
const MAX_OMITTED_FIELDS = 100;

/** A JSON value as returned to the model. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ApiGetArgs {
  /** `/Resource[/…]`, already shape-checked by the tool's input schema. */
  readonly path: string;
  /** sevDesk filters, e.g. `{"contact[id]": 5}`; booleans are sent as `1`/`0`. */
  readonly query?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly limit: number;
  readonly offset: number;
}

interface ApiGetOptions {
  readonly signal?: AbortSignal | undefined;
  /**
   * Values that must never be sent in the query and are redacted from the answer: the
   * configured sevDesk token.
   */
  readonly secrets?: readonly string[] | undefined;
}

/** The tool's output (see `sevdesk_api_get`). */
interface ApiGetResult {
  readonly path: string;
  readonly objects: JsonValue;
  readonly total?: number;
  readonly hasMore: boolean;
  readonly nextOffset?: number;
  readonly omittedFields: string[];
  readonly omittedItems?: number;
}

export interface ApiGetRead {
  readonly result: ApiGetResult;
  /** Rows sevDesk sent when `objects` is a list; `undefined` for one object or a scalar. */
  readonly received: number | undefined;
  /** Rows returned in `result.objects` when it is a list. */
  readonly returned: number | undefined;
  /** More removed fields than `omittedFields` lists ({@link MAX_OMITTED_FIELDS}). */
  readonly omittedFieldsCapped: boolean;
}

/**
 * Sends one GET of `args.path` under the rules of the module doc and returns the cleaned answer.
 * Throws a {@link SevdeskError}: `validation` (nothing sent) for a refused or malformed request,
 * `blocked` if the read-only guard catches a side effect, `unexpected_response` for an answer
 * that is too large, not JSON or not in sevDesk's envelope, and the client's errors otherwise.
 */
export async function apiGet(
  client: SevdeskClient,
  args: ApiGetArgs,
  options: ApiGetOptions = {},
): Promise<ApiGetRead> {
  const { path, limit, offset } = args;
  const query = args.query ?? {};
  assertSafePath(path);
  const secrets = (options.secrets ?? []).filter((secret) => secret.length > 0);
  const leak = secretInRequest(path, query, secrets);
  if (leak !== undefined) {
    // No `path` on the error: it may hold the token itself.
    throw new SevdeskError({ kind: "validation", message: leak, method: "GET" });
  }
  const refusal = genericGetRefusal(path, query);
  if (refusal !== undefined) {
    throw new SevdeskError({ kind: "validation", message: refusal, method: "GET", path });
  }

  const guarded = readOnlyClient(client, "running a generic read (sevdesk_api_get)");
  let answer: { body: Uint8Array; contentType: string | undefined };
  try {
    answer = await guarded.download({
      method: "GET",
      path,
      query: { ...query, limit, offset, countAll: true },
      maxBytes: API_GET_MAX_BODY_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw isOversizedBody(error) ? tooLarge(path) : error;
  }

  if (!isJsonContentType(answer.contentType)) {
    throw unexpected(
      path,
      "sevDesk answered this GET with a file or other non-JSON content, which " +
        "sevdesk_api_get does not return. Use the file tools for documents.",
    );
  }
  const body = parseJson(answer.body, path);
  const envelope = readEnvelope(body);
  if (envelope === undefined) {
    throw unexpected(path, "sevDesk's answer has no 'objects' member, so it could not be read.");
  }
  if (envelope.objects === null && hasErrorMember(body)) {
    // sevDesk's own message stays out: it is untrusted and may echo the request.
    throw unexpected(path, "sevDesk reported an error despite a success status.");
  }

  const cleaner = new Cleaner(secrets);
  const cleaned = cleaner.value(envelope.objects, "", 0);
  const objects = cleaned === DROP ? null : cleaned;
  const total = parseTotal(envelope.total);
  return Array.isArray(objects)
    ? listResult(path, objects, { limit, offset, total }, cleaner)
    : singleResult(path, objects, total, cleaner);
}

function listResult(
  path: string,
  rows: JsonValue[],
  page: { readonly limit: number; readonly offset: number; readonly total: number | undefined },
  cleaner: Cleaner,
): ApiGetRead {
  const kept = fitRows(rows, cleaner);
  const omittedItems = rows.length - kept.length;
  const { hasMore, nextOffset } = paging(rows.length, kept.length, page);
  return {
    result: {
      path,
      objects: kept,
      ...(page.total === undefined ? {} : { total: page.total }),
      hasMore,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      omittedFields: cleaner.listed(),
      ...(omittedItems > 0 ? { omittedItems } : {}),
    },
    received: rows.length,
    returned: kept.length,
    omittedFieldsCapped: cleaner.capped,
  };
}

function singleResult(
  path: string,
  value: JsonValue,
  total: number | undefined,
  cleaner: Cleaner,
): ApiGetRead {
  const objects = jsonBytes(value) > API_GET_MAX_OUTPUT_BYTES ? trim(value, "", cleaner) : value;
  return {
    result: {
      path,
      objects,
      ...(total === undefined ? {} : { total }),
      hasMore: false,
      omittedFields: cleaner.listed(),
    },
    received: undefined,
    returned: undefined,
    omittedFieldsCapped: cleaner.capped,
  };
}

/**
 * Paging for a list answer. Rows cut for size are always "more" (continue at the first cut row).
 * Otherwise an answer longer than `limit` shows an endpoint that ignores `limit` and sent
 * everything; with sevDesk's `total` the shared page maths apply; without one (an endpoint that
 * ignores `countAll`) only a full page may have more, so an endpoint that ignores paging cannot
 * send the model round in circles.
 */
function paging(
  received: number,
  returned: number,
  page: { readonly limit: number; readonly offset: number; readonly total: number | undefined },
): { hasMore: boolean; nextOffset?: number } {
  if (returned < received) return { hasMore: true, nextOffset: page.offset + returned };
  if (received > page.limit) return { hasMore: false };
  if (page.total !== undefined) {
    const state = pageState({ offset: page.offset, received, total: page.total });
    return state.hasMore ? { hasMore: true, nextOffset: state.nextOffset } : { hasMore: false };
  }
  return received > 0 && received >= page.limit
    ? { hasMore: true, nextOffset: page.offset + received }
    : { hasMore: false };
}

/**
 * The longest prefix of `rows` whose compact JSON fits {@link API_GET_MAX_OUTPUT_BYTES}. A first
 * row that alone is too large is kept with its trailing fields cut (and listed), so every call
 * makes progress.
 */
function fitRows(rows: readonly JsonValue[], cleaner: Cleaner): JsonValue[] {
  const budget = API_GET_MAX_OUTPUT_BYTES - 2; // the brackets
  const kept: JsonValue[] = [];
  let used = 0;
  for (const row of rows) {
    const size = jsonBytes(row) + (kept.length === 0 ? 0 : 1); // the comma
    if (used + size > budget) break;
    kept.push(row);
    used += size;
  }
  const first = rows[0];
  if (kept.length === 0 && first !== undefined) kept.push(trim(first, "/*", cleaner));
  return kept;
}

/**
 * `value` cut to {@link API_GET_MAX_OUTPUT_BYTES}: an object keeps the fields that fit, in order,
 * a list its leading items; what is cut is listed under `pointer`. Scalars are already capped.
 */
function trim(value: JsonValue, pointer: string, cleaner: Cleaner): JsonValue {
  const budget = API_GET_MAX_OUTPUT_BYTES - 2;
  let used = 0;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const size = jsonBytes(item) + 1;
      if (used + size > budget) {
        cleaner.omit(`${pointer}/*`);
        break;
      }
      items.push(item);
      used += size;
    }
    return items;
  }
  if (value === null || typeof value !== "object") return value;
  const entries: [string, JsonValue][] = [];
  for (const [key, item] of Object.entries(value)) {
    const size = jsonBytes(key) + jsonBytes(item) + 2;
    if (used + size > budget) {
      cleaner.omit(`${pointer}/${escapePointer(key)}`);
      continue;
    }
    entries.push([key, item]);
    used += size;
  }
  return Object.fromEntries(entries);
}

/** Marks a value the cleaner removed. */
const DROP: unique symbol = Symbol("drop");

/**
 * Cleans a parsed answer and remembers what it removed, as JSON pointers relative to `objects`
 * with `*` for "every element" of a list (so one removed field of every row is listed once).
 */
class Cleaner {
  private readonly omitted = new Set<string>();
  capped = false;

  constructor(private readonly secrets: readonly string[]) {}

  omit(pointer: string): void {
    if (this.omitted.has(pointer)) return;
    if (this.omitted.size >= MAX_OMITTED_FIELDS) {
      this.capped = true;
      return;
    }
    this.omitted.add(pointer);
  }

  listed(): string[] {
    return [...this.omitted];
  }

  value(raw: unknown, pointer: string, depth: number): JsonValue | typeof DROP {
    if (depth > MAX_DEPTH) return this.drop(pointer);
    if (raw === null || typeof raw === "boolean") return raw;
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : this.drop(pointer);
    if (typeof raw === "string") return isBinaryString(raw) ? this.drop(pointer) : this.text(raw);
    if (Array.isArray(raw)) return this.list(raw, pointer, depth);
    if (typeof raw === "object") return this.record(raw as Record<string, unknown>, pointer, depth);
    return this.drop(pointer);
  }

  private drop(pointer: string): typeof DROP {
    this.omit(pointer);
    return DROP;
  }

  private text(raw: string): string {
    // Invisible characters first, so a token split by zero-width characters is still found.
    let text = sanitizeUntrusted(raw, Number.POSITIVE_INFINITY);
    const lower = text.toLowerCase();
    if (this.secrets.some((secret) => lower.includes(secret.toLowerCase()))) {
      text = redactSecrets(text, this.secrets);
    }
    return sanitizeUntrusted(text, MAX_UNTRUSTED_LENGTH);
  }

  private list(raw: readonly unknown[], pointer: string, depth: number): JsonValue[] {
    const items: JsonValue[] = [];
    for (const item of raw) {
      const value = this.value(item, `${pointer}/*`, depth + 1);
      if (value !== DROP) items.push(value);
    }
    return items;
  }

  private record(
    raw: Readonly<Record<string, unknown>>,
    pointer: string,
    depth: number,
  ): { [key: string]: JsonValue } {
    const entries = new Map<string, JsonValue>();
    for (const [rawKey, rawValue] of Object.entries(raw)) {
      const key = sanitizeUntrusted(rawKey, MAX_KEY_LENGTH);
      const at = `${pointer}/${escapePointer(key)}`;
      // `__proto__` would not survive output validation; a key that collides after cleaning
      // would overwrite another field.
      if (key === "__proto__" || entries.has(key) || isBinaryField(rawKey, rawValue, raw)) {
        this.omit(at);
        continue;
      }
      if (rawKey.toLowerCase() === "sevclient" && isObject(rawValue)) {
        this.omit(at);
        continue;
      }
      const value = this.value(rawValue, at, depth + 1);
      if (value !== DROP) entries.set(key, value);
    }
    return Object.fromEntries(entries);
  }
}

/**
 * Named binary fields: `content` next to a truthy `base64Encoded` (sevDesk's file answers,
 * spec/deviations.md D-072), `pdf`, `base64` and `thumb…`, unless empty.
 */
function isBinaryField(
  key: string,
  value: unknown,
  parent: Readonly<Record<string, unknown>>,
): boolean {
  if (value === null || value === "" || typeof value === "boolean" || typeof value === "number") {
    return false;
  }
  const name = key.toLowerCase();
  if (name === "pdf" || name === "base64" || name.startsWith("thumb")) return true;
  if (name !== "content") return false;
  const flag = Object.entries(parent).find(
    ([sibling]) => sibling.toLowerCase() === "base64encoded",
  );
  return flag !== undefined && isTruthy(flag[1]);
}

/** A long string of base64 (or base64url) characters, or a `data:…;base64,` URI of one. */
function isBinaryString(value: string): boolean {
  if (value.length <= BINARY_MIN_LENGTH) return false;
  const dataUri = /^data:[^,]{0,200};base64,/i.exec(value);
  const body = (dataUri === null ? value : value.slice(dataUri[0].length)).replace(/[\r\n]/g, "");
  return body.length > BINARY_MIN_LENGTH && /^[A-Za-z0-9+/_-]+={0,2}$/.test(body);
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/** RFC 6901 escaping of one reference token. */
function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * A refusal when the path or a query value contains one of `secrets` (any case), as trusted
 * text that never repeats it. Checked before anything else, so no error carries the secret.
 */
function secretInRequest(
  path: string,
  query: Readonly<Record<string, string | number | boolean>>,
  secrets: readonly string[],
): string | undefined {
  const parts = [path, ...Object.keys(query), ...Object.values(query).map(String)];
  const leaks = parts.some((part) => {
    const text = part.toLowerCase();
    return secrets.some((secret) => text.includes(secret.toLowerCase()));
  });
  return leaks
    ? "The request contains this server's sevDesk API token. Credentials never go into the URL; " +
        "the server sends the token in the Authorization header itself."
    : undefined;
}

/** `application/json`, `application/problem+json`, `text/json`, with parameters. */
function isJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type === "application/json" || type === "text/json" || /^application\/[\w.-]+\+json$/.test(type)
  );
}

function hasErrorMember(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const error: unknown = (body as Record<string, unknown>)["error"];
  return error !== undefined && error !== null;
}

function parseJson(body: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw unexpected(path, "sevDesk's answer is not valid JSON, so it could not be read.");
  }
}

/** The client's cap error: `unexpected_response` with a 2xx status (sevDesk answered fine). */
function isOversizedBody(error: unknown): boolean {
  return (
    error instanceof SevdeskError &&
    error.kind === "unexpected_response" &&
    error.status !== undefined &&
    error.status >= 200 &&
    error.status < 300
  );
}

function tooLarge(path: string): SevdeskError {
  return new SevdeskError({
    kind: "unexpected_response",
    message:
      `sevDesk's answer is larger than ${API_GET_MAX_BODY_BYTES / (1024 * 1024)} MiB, the limit ` +
      "of sevdesk_api_get, so none of it was read. Ask for fewer rows (a smaller limit) or " +
      "narrow the query.",
    method: "GET",
    path,
    expectedLimit: true,
  });
}

function unexpected(path: string, message: string): SevdeskError {
  return new SevdeskError({ kind: "unexpected_response", message, method: "GET", path });
}
