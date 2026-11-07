/**
 * Contract of the sevDesk HTTP client. Domain code and tools depend on this interface only; tests
 * substitute a fake. The implementation lives in `client.ts`.
 */
import type { Tier } from "../safety/tiers.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Query values. Booleans are sent as `1`/`0` (sevDesk ignores a literal `false`). */
export type QueryValue = string | number | boolean | undefined;

export interface SevdeskRequest {
  readonly method: HttpMethod;
  /**
   * Path below the base URL, starting with `/`, e.g. `/Contact` or `/Invoice/123/getPdf`.
   * The client rejects `..`, `//`, query strings and non-ASCII here (use `query`).
   */
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  /** JSON body (mutually exclusive with `form`). */
  readonly body?: unknown;
  /** Multipart body, e.g. for `Voucher/Factory/uploadTempFile`. */
  readonly form?: FormData;
  readonly signal?: AbortSignal;
  /**
   * Marks a GET that changes state in sevDesk (e.g. `getPdf` without `preventSendBy=true`,
   * `sendByWithRender`). Such requests count as writes: read-only mode blocks them and they are
   * never retried. The client also recognizes the known state-changing GET endpoints by path, so
   * this flag is a declaration of intent, not the only line of defense.
   */
  readonly sideEffect?: boolean;
  /**
   * Tier of the tool making a request that changes data (any non-GET, or a side-effect GET).
   * Required for those requests: the client refuses them unless this tier is enabled in the
   * configuration, so a write-tier tool cannot reach a commit-tier endpoint by mistake. Ignored for
   * plain reads.
   */
  readonly tier?: Exclude<Tier, "read">;
}

export interface ListOptions {
  /** Page size, 1–1000. Always sent explicitly: omitting it silently truncates at 100. */
  readonly limit?: number;
  readonly offset?: number;
  readonly signal?: AbortSignal;
}

export interface Page<T = unknown> {
  readonly items: readonly T[];
  /** From `countAll=true` (sevDesk returns it as a string; parsed here). */
  readonly total: number | undefined;
}

export interface ListAllOptions {
  /** Hard cap on items fetched across pages; the result says whether it was hit. */
  readonly max: number;
  readonly pageSize?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (fetched: number, total: number | undefined) => void;
}

export interface CollectedList<T = unknown> {
  readonly items: readonly T[];
  readonly total: number | undefined;
  /** True when `max` stopped paging before the end. */
  readonly truncated: boolean;
}

export interface SevdeskClient {
  /**
   * Sends one request and returns the unwrapped payload (the `objects` member of sevDesk's
   * envelope). Throws `SevdeskError` on any failure.
   */
  request(request: SevdeskRequest): Promise<unknown>;

  /** GET one page of a collection, with `countAll`. */
  list(
    path: string,
    query?: Readonly<Record<string, QueryValue>>,
    options?: ListOptions,
  ): Promise<Page>;

  /** GET pages until an empty page or `max` items (never trusts a short page as the end). */
  listAll(
    path: string,
    query: Readonly<Record<string, QueryValue>> | undefined,
    options: ListAllOptions,
  ): Promise<CollectedList>;

  /** Raw-body GET for endpoints that return CSV/ZIP/XML instead of JSON. */
  download(request: SevdeskRequest): Promise<{ body: Uint8Array; contentType: string | undefined }>;
}
