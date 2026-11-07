/**
 * Shared paging for list tools. sevDesk may return a short page in the middle of a collection, so
 * the next page always starts at `offset + received` (never `offset + limit`), and without a total
 * any non-empty page may have more after it; an empty page ends the list.
 *
 * Also the two ways domain modules read collections: one page of a list ({@link readPage}) and
 * every row of one parent, such as a document's positions ({@link listChildRows}).
 */
import { z } from "zod";

import type { QueryValue, SevdeskClient } from "../sevdesk/types.js";

export interface PageWindow {
  readonly offset: number;
  /** Rows sevDesk returned for this page (before any local de-duplication or filtering). */
  readonly received: number;
  /** From `countAll`, when sevDesk reported it. */
  readonly total: number | undefined;
}

export interface PageState {
  readonly hasMore: boolean;
  /** Where the next page starts: `offset + received`. */
  readonly nextOffset: number;
}

export function pageState(window: PageWindow): PageState {
  const nextOffset = window.offset + window.received;
  const hasMore = window.received > 0 && (window.total === undefined || nextOffset < window.total);
  return { hasMore, nextOffset };
}

/** `limit`/`offset` input fields for a list tool; spread into its `z.strictObject({...})`. */
export function pagingInputShape(defaults: { readonly limit: number; readonly max: number }) {
  return {
    limit: z
      .number()
      .int()
      .min(1)
      .max(defaults.max)
      .default(defaults.limit)
      .describe(`Page size, 1–${defaults.max}.`),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Rows to skip, for paging: pass the previous result's nextOffset."),
  };
}

/** Output fields describing a page; spread next to `items` in a list tool's output object. */
export const pageOutputShape = {
  total: z.number().int().optional().describe("All matches in sevDesk, when sevDesk reports it."),
  offset: z.number().int(),
  limit: z.number().int(),
  hasMore: z
    .boolean()
    .describe("More rows may follow: call again with offset = nextOffset. An empty page ends."),
  nextOffset: z
    .number()
    .int()
    .optional()
    .describe("offset plus the rows sevDesk returned; sevDesk may return fewer rows than limit."),
};

/** Values for the {@link pageOutputShape} fields. */
export interface PageOutput {
  total?: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
}

/**
 * The {@link pageOutputShape} fields of a page, to spread next to `items`: `total` only when
 * sevDesk reported it, `nextOffset` only when more rows may follow.
 */
export function pageOutput(window: PageWindow, state: PageState, limit: number): PageOutput {
  return {
    ...(window.total === undefined ? {} : { total: window.total }),
    offset: window.offset,
    limit,
    hasMore: state.hasMore,
    ...(state.hasMore ? { nextOffset: state.nextOffset } : {}),
  };
}

/**
 * One trusted summary sentence for a page, e.g. "Invoices 1–25 of 140; more may follow
 * (nextOffset 25)." `noun` is a trusted plural such as "Invoices".
 */
export function pageSummary(noun: string, window: PageWindow, state: PageState): string {
  if (window.received === 0) {
    return window.offset === 0
      ? `No ${noun.toLowerCase()} found.`
      : `No more ${noun.toLowerCase()} after offset ${window.offset}.`;
  }
  const range = `${window.offset + 1}–${state.nextOffset}`;
  const of = window.total === undefined ? "" : ` of ${window.total}`;
  const more = state.hasMore ? `; more may follow (nextOffset ${state.nextOffset})` : "";
  return `${noun} ${range}${of}${more}.`;
}

/** One page of a list, mapped. */
export interface ListPage<T> {
  readonly items: readonly T[];
  readonly window: PageWindow;
  readonly state: PageState;
}

/**
 * Reads one page of `path` with sevDesk's filters in `query` (the client adds `limit`, `offset`
 * and `countAll`) and maps every row; `map` throws `unexpected_response` for a row that does not
 * fit.
 */
export async function readPage<T>(
  client: SevdeskClient,
  path: string,
  query: Readonly<Record<string, QueryValue>>,
  page: { readonly limit: number; readonly offset: number },
  map: (raw: unknown) => T,
  signal?: AbortSignal,
): Promise<ListPage<T>> {
  const result = await client.list(path, query, {
    limit: page.limit,
    offset: page.offset,
    ...(signal === undefined ? {} : { signal }),
  });
  const window: PageWindow = {
    offset: page.offset,
    received: result.items.length,
    total: result.total,
  };
  return { items: result.items.map(map), window, state: pageState(window) };
}

/** sevDesk's maximum page size, used to read the rows of one parent. */
const CHILD_PAGE_SIZE = 1000;
/** Cap when the rows of one parent have to be read page by page. */
const CHILD_MAX_ROWS = 10_000;

/** The rows of one parent; see {@link listChildRows}. */
export interface ChildRows<T> {
  readonly rows: readonly T[];
  /** False when the cap stopped reading before the end; `rows` is then partial. */
  readonly complete: boolean;
}

/**
 * Reads every row of one parent (a contact's addresses, a document's positions) from a collection
 * that takes a parent filter such as `voucher[id]`/`voucher[objectName]`.
 *
 * Each row is also checked with `belongs`, so a filter sevDesk ignores cannot mix in other
 * parents' rows. One page of {@link CHILD_PAGE_SIZE} rows suffices when every row belongs to the
 * parent and sevDesk's total shows nothing is left (or the page is empty). Otherwise the
 * collection is read page by page up to {@link CHILD_MAX_ROWS} rows and filtered here; hitting
 * that cap gives `complete: false` instead of a silently short list.
 */
export async function listChildRows<T>(
  client: SevdeskClient,
  path: string,
  filter: Readonly<Record<string, QueryValue>>,
  rows: { readonly parse: (raw: unknown) => T; readonly belongs: (row: T) => boolean },
  signal: AbortSignal | undefined,
): Promise<ChildRows<T>> {
  const withSignal = signal === undefined ? {} : { signal };
  const page = await client.list(path, filter, { limit: CHILD_PAGE_SIZE, ...withSignal });
  const first = page.items.map(rows.parse);
  const received = page.items.length;
  const nothingLeft = received === 0 || (page.total !== undefined && page.total <= received);
  if (first.every(rows.belongs) && nothingLeft) {
    return { rows: first, complete: true };
  }

  const all = await client.listAll(path, filter, {
    max: CHILD_MAX_ROWS,
    pageSize: CHILD_PAGE_SIZE,
    ...withSignal,
  });
  return { rows: all.items.map(rows.parse).filter(rows.belongs), complete: !all.truncated };
}
