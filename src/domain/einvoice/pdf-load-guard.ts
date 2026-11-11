/**
 * Bounds the decompression pdf-lib does while it *loads* a PDF. pdf-lib decodes every object
 * stream (`/Type /ObjStm`) and cross-reference stream (`/Type /XRef`) synchronously during
 * `PDFDocument.load`, without any size limit; a 20 MB hostile PDF with one FlateDecode object
 * stream (deflate reaches about 1000:1) would hang or exhaust the server's memory from a read
 * tool. Nothing else is decoded at load time (content, image and font streams are only decoded
 * when rendering, which this server never does; the e-invoice attachment is inflated by
 * `pdf-attachment.ts` with its own cap).
 *
 * How: the static factories `PDFObjectStreamParser.forStream` and `PDFXRefStreamParser.forStream`
 * are wrapped once (the only two places pdf-lib 1.17.1 decodes at load, see
 * `core/parser/PDFParser.js#parseIndirectObject`). Before pdf-lib decodes such a stream, the
 * wrapper checks its filter, which must be none or a single `FlateDecode` (other filters are
 * refused: LZW and RunLength can expand as well), and inflates it with Node's zlib under
 * `maxOutputLength`, charging the result to the budget of the current load
 * ({@link MAX_PDF_LOAD_INFLATED_BYTES} in total, scoped per call with `AsyncLocalStorage`, so
 * concurrent loads do not share a budget). This inspects exactly the streams pdf-lib is about to
 * decode, with pdf-lib's own view of their dictionaries (names with `#` escapes, indirect
 * `/Type` and `/Filter` values), which a byte-level pre-scan could be fooled about.
 *
 * pdf-lib catches errors of a single object and goes on loading, so a violation is also recorded
 * in the load's budget and reported by {@link withPdfLoadBudget} after the load returns.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { constants, inflateSync } from "node:zlib";

import {
  PDFArray,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFObjectStreamParser,
  type PDFRawStream,
  PDFXRefStreamParser,
} from "pdf-lib";

import { SevdeskError } from "../../sevdesk/errors.js";

/** Most bytes the object and cross-reference streams of one PDF may decode to, in total. */
export const MAX_PDF_LOAD_INFLATED_BYTES = 64 * 1024 * 1024;

interface LoadBudget {
  /** The limit of this load, for messages. */
  readonly limit: number;
  remaining: number;
  /** The first violation's trusted reason; once set, every further stream is refused. */
  violation: string | undefined;
}

const budgets = new AsyncLocalStorage<LoadBudget>();
let installed = false;

/**
 * Runs `load` (a `PDFDocument.load` call) with a fresh decompression budget of `limit` bytes.
 * Throws a local `validation` {@link SevdeskError} when a stream exceeds the budget or uses a
 * filter that is not allowed, even if pdf-lib itself swallowed the error.
 */
export async function withPdfLoadBudget<T>(
  load: () => Promise<T>,
  limit: number = MAX_PDF_LOAD_INFLATED_BYTES,
): Promise<T> {
  installGuard();
  const budget: LoadBudget = { limit, remaining: limit, violation: undefined };
  let result: T;
  try {
    result = await budgets.run(budget, load);
  } catch (error) {
    if (budget.violation !== undefined) throw refusal(budget.violation);
    throw error;
  }
  if (budget.violation !== undefined) throw refusal(budget.violation);
  return result;
}

function installGuard(): void {
  if (installed) return;
  installed = true;
  const objectStream = PDFObjectStreamParser.forStream;
  PDFObjectStreamParser.forStream = (rawStream, shouldWaitForTick) => {
    const { size, budget } = charge(rawStream);
    checkObjectStreamShape(rawStream, size, budget);
    return objectStream(rawStream, shouldWaitForTick);
  };
  const xrefStream = PDFXRefStreamParser.forStream;
  PDFXRefStreamParser.forStream = (rawStream) => {
    const { size, budget } = charge(rawStream);
    checkXRefShape(rawStream, size, budget);
    return xrefStream(rawStream);
  };
}

/**
 * Most cross-reference and object-stream entries one PDF may declare in total. pdf-lib loops once
 * per declared entry whatever the stream holds, so a 238-byte PDF declaring `/Size 1000000000`
 * with zero-width fields made a billion entries under a one-byte budget (security review
 * 2026-11, wave 2). An e-invoice PDF has a few thousand objects.
 */
const MAX_PDF_ENTRIES = 200_000;
/** A field of a cross-reference stream is at most this many bytes wide (PDF uses 1–4, 8 at most). */
const MAX_XREF_FIELD_WIDTH = 8;

const entryCounts = new WeakMap<LoadBudget, number>();

function integerOf(value: PDFObject | undefined): number | undefined {
  return value instanceof PDFNumber && Number.isSafeInteger(value.asNumber())
    ? value.asNumber()
    : undefined;
}

function integersOf(value: PDFObject | undefined): number[] | undefined {
  if (!(value instanceof PDFArray)) return undefined;
  const numbers = value.asArray().map(integerOf);
  return numbers.every((n): n is number => n !== undefined && n >= 0) ? numbers : undefined;
}

/** Counts `entries` against the PDF's total; throws when it runs over. */
function countEntries(budget: LoadBudget, entries: number): void {
  const total = (entryCounts.get(budget) ?? 0) + entries;
  entryCounts.set(budget, total);
  if (total > MAX_PDF_ENTRIES) {
    violate(budget, "The PDF declares more internal objects than this server reads");
  }
}

/**
 * Checks a cross-reference stream before pdf-lib reads it: field widths `/W` of three small
 * integers, entries from `/Index` (pairs) or `/Size`, and the decoded data large enough to hold
 * every entry (each takes the sum of the widths). Zero-width entries are refused: they cost
 * nothing in bytes but a loop round each.
 */
function checkXRefShape(stream: PDFRawStream, size: number, budget: LoadBudget): void {
  const malformed = (): never => violate(budget, "The PDF's cross-reference stream is malformed");
  const widths = integersOf(stream.dict.lookup(PDFName.of("W")));
  if (widths?.length !== 3 || widths.some((w) => w > MAX_XREF_FIELD_WIDTH)) return malformed();
  const entryWidth = widths.reduce((sum, w) => sum + w, 0);
  const index = stream.dict.lookup(PDFName.of("Index"));
  let entries: number;
  if (index === undefined) {
    entries = integerOf(stream.dict.lookup(PDFName.of("Size"))) ?? malformed();
  } else {
    const pairs = integersOf(index);
    if (pairs === undefined || pairs.length % 2 !== 0) return malformed();
    entries = pairs.reduce((sum, n, i) => (i % 2 === 1 ? sum + n : sum), 0);
  }
  if (entries < 0) return malformed();
  if (entries > 0 && (entryWidth === 0 || entries * entryWidth > size)) return malformed();
  countEntries(budget, entries);
}

/** Checks an object stream's `/N` against its data: each object needs at least its header pair. */
function checkObjectStreamShape(stream: PDFRawStream, size: number, budget: LoadBudget): void {
  const objects = integerOf(stream.dict.lookup(PDFName.of("N")));
  // "1 0 " is the shortest header pair: four bytes per object at least.
  if (objects === undefined || objects < 0 || objects * 4 > size) {
    violate(budget, "The PDF's object stream is malformed");
  }
  countEntries(budget, objects);
}

/**
 * Charges a stream's decoded size to the current budget; throws when it does not fit. Returns the
 * size and the budget it was charged to.
 */
function charge(stream: PDFRawStream): { size: number; budget: LoadBudget } {
  // Outside withPdfLoadBudget (not used by this server) every stream gets the full limit.
  const budget = budgets.getStore() ?? {
    limit: MAX_PDF_LOAD_INFLATED_BYTES,
    remaining: MAX_PDF_LOAD_INFLATED_BYTES,
    violation: undefined,
  };
  if (budget.violation !== undefined) throw new Error(budget.violation);
  const size = decodedSize(stream, budget);
  budget.remaining -= size;
  return { size, budget };
}

function decodedSize(stream: PDFRawStream, budget: LoadBudget): number {
  const filters = filterNames(stream.dict.lookup(PDFName.of("Filter")));
  if (filters === undefined || filters.length > 1) {
    return violate(
      budget,
      "The PDF compresses its internal structure in a way this server does not read",
    );
  }
  const contents = stream.contents;
  if (filters.length === 0) {
    if (contents.byteLength > budget.remaining) return violate(budget, tooLarge(budget.limit));
    return contents.byteLength;
  }
  if (filters[0] !== "FlateDecode" && filters[0] !== "Fl") {
    return violate(
      budget,
      "The PDF compresses its internal structure in a way this server does not read",
    );
  }
  // Measured with zlib alone, never with a raw-deflate fallback: pdf-lib's decoder reads
  // zlib-wrapped data only and is MORE lenient than zlib (no window-size check, odd stored
  // blocks, back references before the start). A stream that zlib refuses but raw deflate reads
  // as a few bytes can still be a bomb for pdf-lib, so anything zlib cannot read counts as
  // damaged and is refused. When zlib does read it, both decoders produce the same bytes, so the
  // size is exact. Z_SYNC_FLUSH keeps streams without a checksum tail readable, as in pdf-lib.
  const options = {
    maxOutputLength: Math.max(budget.remaining, 1),
    finishFlush: constants.Z_SYNC_FLUSH,
  };
  try {
    const size = inflateSync(contents, options).byteLength;
    if (size > budget.remaining) return violate(budget, tooLarge(budget.limit));
    return size;
  } catch (error) {
    if (error instanceof RangeError || isBufferTooLarge(error)) {
      return violate(budget, tooLarge(budget.limit));
    }
    return violate(
      budget,
      "The PDF's internal structure is damaged (a compressed stream cannot be read)",
    );
  }
}

/** Filter names (without the slash); `undefined` for anything but a name or an array of names. */
function filterNames(filter: PDFObject | undefined): string[] | undefined {
  if (filter === undefined) return [];
  if (filter instanceof PDFName) return [filter.decodeText()];
  if (filter instanceof PDFArray) {
    const names: string[] = [];
    for (let index = 0; index < filter.size(); index += 1) {
      const entry = filter.lookup(index);
      if (!(entry instanceof PDFName)) return undefined;
      names.push(entry.decodeText());
    }
    return names;
  }
  return undefined;
}

function violate(budget: LoadBudget, reason: string): never {
  budget.violation ??= reason;
  budget.remaining = 0;
  throw new Error(reason);
}

function isBufferTooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
  );
}

function tooLarge(limit: number): string {
  return (
    "The PDF's internal structure decompresses to more than " +
    `${String(limit)} bytes (a "zip bomb"), so it is not read`
  );
}

function refusal(reason: string): SevdeskError {
  return new SevdeskError({
    kind: "validation",
    message: `${reason}. Nothing was sent to sevDesk.`,
  });
}
