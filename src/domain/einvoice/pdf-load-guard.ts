/**
 * Bounds what pdf-lib does while it *loads* a PDF: the bytes it decompresses, the values it
 * builds and the steps its parser takes. Reading an e-invoice PDF is a read tool, so one small
 * hostile file must not be able to hang the server or exhaust its memory.
 *
 * **Decompression.** pdf-lib decodes every object stream (`/Type /ObjStm`) and cross-reference
 * stream (`/Type /XRef`) synchronously during `PDFDocument.load`, without any size limit; a 20 MB
 * hostile PDF with one FlateDecode object stream (deflate reaches about 1000:1) would hang or
 * exhaust the server's memory. Nothing else is decoded at load time (content, image and font
 * streams are only decoded when rendering, which this server never does; the e-invoice attachment
 * is inflated by `pdf-attachment.ts` with its own cap). The static factories
 * `PDFObjectStreamParser.forStream` and `PDFXRefStreamParser.forStream` are wrapped once (the only
 * two places pdf-lib 1.17.1 decodes at load, see `core/parser/PDFParser.js#parseIndirectObject`).
 * Before pdf-lib decodes such a stream, the wrapper checks its filter, which must be none or a
 * single `FlateDecode` (other filters are refused: LZW and RunLength can expand as well), and
 * inflates it with Node's zlib under `maxOutputLength`, charging the result to the budget of the
 * current load ({@link MAX_PDF_LOAD_INFLATED_BYTES} in total). This inspects exactly the streams
 * pdf-lib is about to decode, with pdf-lib's own view of their dictionaries (names with `#`
 * escapes, indirect `/Type` and `/Filter` values), which a byte-level pre-scan could be fooled
 * about. The same wrappers check the declared shape: entry counts against the data, and the
 * header of an object stream.
 *
 * **Built values and parser steps** (review 2026-11, round 3). Bounding the decoded bytes does not
 * bound what the parser makes of them: an object stream whose header points 4,000 object numbers
 * at one array of 20,000 numbers made pdf-lib build that array 4,000 times (a 66 KiB file, 19 s,
 * 2.8 GiB of heap); nested arrays with honest offsets, or one array of millions of numbers in a
 * plain object, cost the same; junk between two objects is searched for an object header at
 * every byte, which is quadratic for a long run of digits or blanks (a 98 KiB file, 68 s); and
 * pdf-lib builds every string, name and number one character at a time, which costs about 32
 * bytes of heap per byte while the token is read. So three more things are hooked, once, on
 * pdf-lib's parser prototypes:
 *
 * - `PDFObjectParser.prototype.parseObject` counts every value the load parses (each indirect
 *   object, array element and dictionary value) against {@link MAX_PDF_LOAD_VALUES}.
 * - `ByteStream.prototype.next`, the one method every parser loop advances with, counts steps:
 *   a load may take `STEPS_PER_BYTE` steps per byte of the file and `STREAM_STEPS_PER_BYTE` per
 *   decoded byte of an object or cross-reference stream. At the limits (a 20 MB file, 64 MiB of
 *   decoded streams) that is about 700 million steps, some seconds of one busy thread.
 * - The token readers (`parseRawInt`, `parseRawNumber`, `parseName`, `parseString`,
 *   `parseHexString`) are limited in length; a hex string is kept as a flat copy.
 *
 * The limits stop the work where it happens, not after the parse: the first violation zeroes the
 * load's counters, so every byte stream of that load ends at its next step (its length is set to
 * zero, which is what pdf-lib's loops test), and the load returns or fails at once.
 *
 * Everything is scoped per call with `AsyncLocalStorage`, so concurrent loads do not share a
 * budget. pdf-lib catches errors of a single object and goes on loading, so a violation is also
 * recorded in the load's budget and reported by {@link withPdfLoadBudget} after the load returns.
 *
 * Not bounded here: pdf-lib interns every distinct name and reference in module-level pools that
 * are never emptied, so hostile PDFs with many distinct names grow the process a little with
 * every load (at most {@link MAX_PDF_LOAD_VALUES} names per load).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { constants, inflateSync } from "node:zlib";

import {
  PDFArray,
  PDFContext,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFObjectParser,
  PDFObjectStreamParser,
  type PDFRawStream,
  PDFXRefStreamParser,
} from "pdf-lib";

import { SevdeskError } from "../../sevdesk/errors.js";

/** Most bytes the object and cross-reference streams of one PDF may decode to, in total. */
export const MAX_PDF_LOAD_INFLATED_BYTES = 64 * 1024 * 1024;

/**
 * Most values (indirect objects, array elements, dictionary values) pdf-lib may parse in one
 * load. Each costs 50 to 100 bytes of heap, so the cap keeps one load below about 100 MB. Real
 * PDFs stay far below it: values outside of streams are the document's structure, not its
 * content (the fixture PDFs have 40 to 70; a tagged document of several hundred pages has a few
 * hundred thousand).
 */
export const MAX_PDF_LOAD_VALUES = 1_000_000;

/**
 * Parser steps a load may take per byte of the file. pdf-lib takes 2 to 4 steps per byte for
 * objects, 6 to 9 while it searches the end of a stream without a usable `/Length`, up to 10
 * while it skips junk between objects; its quadratic paths take thousands.
 */
const STEPS_PER_BYTE = 16;
/**
 * Steps per decoded byte of an object or cross-reference stream. Less than for the file: such a
 * stream holds objects only (at most 4 steps per byte), no junk to skip and no streams whose end
 * has to be searched, and its decoded size (up to {@link MAX_PDF_LOAD_INFLATED_BYTES} from a few
 * KiB of file) is what a hostile file gets the most steps from.
 */
const STREAM_STEPS_PER_BYTE = 6;
/** Steps every load may take on top, so tiny files never come near the limit. */
const STEP_SLACK = 10_000;

/** Longest number (digits, sign, point) the parser reads; real ones have under 20 bytes. */
const MAX_NUMBER_BYTES = 256;
/** Longest name; PDF 1.7 allowed 127 bytes. */
const MAX_NAME_BYTES = 1024;
/**
 * Longest literal or hex string. The largest strings of real PDFs are signature containers
 * (`/Contents`, tens of KiB of hex digits); longer data lives in streams.
 */
const MAX_STRING_BYTES = 1024 * 1024;

interface LoadBudget {
  /** The decompression limit of this load, for messages. */
  readonly limit: number;
  /** Bytes the load may still decompress. */
  remaining: number;
  /** Values the load may still parse. */
  values: number;
  /** Steps the load's parsers may still take; grows with every byte stream the load opens. */
  steps: number;
  /** The first violation's trusted reason; once set, every further piece of work is refused. */
  violation: string | undefined;
}

function newBudget(limit: number, maxValues: number): LoadBudget {
  return { limit, remaining: limit, values: maxValues, steps: STEP_SLACK, violation: undefined };
}

const budgets = new AsyncLocalStorage<LoadBudget>();
let installed = false;

/**
 * Runs `load` (a `PDFDocument.load` call) with a fresh budget: `limit` bytes of decompression
 * and `maxValues` parsed values. Throws a local `validation` {@link SevdeskError} when the load
 * exceeds a limit of this module or a stream uses a filter that is not allowed, even if pdf-lib
 * itself swallowed the error.
 */
export async function withPdfLoadBudget<T>(
  load: () => Promise<T>,
  limit: number = MAX_PDF_LOAD_INFLATED_BYTES,
  maxValues: number = MAX_PDF_LOAD_VALUES,
): Promise<T> {
  installGuard();
  const budget = newBudget(limit, maxValues);
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

const BUDGET = Symbol("pdfLoadBudget");
const TOKEN_LEFT = Symbol("pdfLoadTokenLeft");

/** pdf-lib's `ByteStream` (not exported), with the two fields this guard hangs on an instance. */
interface GuardedStream {
  /** Private in pdf-lib: `done()` is `idx >= length`. */
  length: number;
  next: (this: GuardedStream) => number;
  [BUDGET]?: LoadBudget;
  /** Bytes the token being read may still take; `Infinity` between tokens. */
  [TOKEN_LEFT]?: number;
}

interface GuardedParser {
  /** Protected in pdf-lib's `BaseParser`. */
  readonly bytes: GuardedStream;
}

type ParserMethod = (this: GuardedParser) => unknown;

function installGuard(): void {
  if (installed) return;
  installed = true;
  const objectStream = PDFObjectStreamParser.forStream;
  PDFObjectStreamParser.forStream = (rawStream, shouldWaitForTick) => {
    const { data, budget } = charge(rawStream);
    checkObjectStreamShape(rawStream, data, budget);
    const parser = objectStream(rawStream, shouldWaitForTick);
    attach((parser as unknown as GuardedParser).bytes, budget, STREAM_STEPS_PER_BYTE);
    return parser;
  };
  const xrefStream = PDFXRefStreamParser.forStream;
  PDFXRefStreamParser.forStream = (rawStream) => {
    const { data, budget } = charge(rawStream);
    checkXRefShape(rawStream, data.byteLength, budget);
    const parser = xrefStream(rawStream);
    attach((parser as unknown as GuardedParser).bytes, budget, STREAM_STEPS_PER_BYTE);
    return parser;
  };

  // The parsers of a load (PDFParser, PDFObjectStreamParser) inherit from PDFObjectParser, so a
  // method set on its prototype is the one they all call, also in pdf-lib's own recursion.
  const parser = PDFObjectParser.prototype as unknown as Record<string, ParserMethod | undefined>;
  const method = (name: string): ParserMethod => {
    const found = parser[name];
    if (typeof found !== "function") throw new Error(`pdf-lib has no parser method ${name}`);
    return found;
  };
  // ByteStream is not exported; its prototype is taken from the byte stream of a parser.
  const probe = PDFObjectParser.forBytes(new Uint8Array(0), PDFContext.create());
  const stream = Object.getPrototypeOf((probe as unknown as GuardedParser).bytes) as GuardedStream;

  const next = stream.next;
  stream.next = function (this: GuardedStream): number {
    const budget = this[BUDGET] ?? budgetOf(this);
    budget.steps -= 1;
    const tokenLeft = (this[TOKEN_LEFT] ?? Infinity) - 1;
    this[TOKEN_LEFT] = tokenLeft;
    if (budget.steps < 0) {
      return stop(this, budget, "The PDF is damaged in a way that takes too much work to read");
    }
    if (tokenLeft < 0) {
      return stop(
        this,
        budget,
        "The PDF holds a name, number or string longer than this server reads",
      );
    }
    return next.call(this);
  };

  const parseObject = method("parseObject");
  parser.parseObject = function (this: GuardedParser): unknown {
    const budget = budgetOf(this.bytes);
    budget.values -= 1;
    if (budget.values < 0) {
      return stop(
        this.bytes,
        budget,
        "The PDF's internal structure holds more values than this server reads",
      );
    }
    return parseObject.call(this);
  };

  const limitToken = (name: string, maxBytes: number): void => {
    const original = method(name);
    parser[name] = function (this: GuardedParser): unknown {
      const bytes = this.bytes;
      budgetOf(bytes);
      const outer = bytes[TOKEN_LEFT] ?? Infinity;
      bytes[TOKEN_LEFT] = maxBytes;
      try {
        return original.call(this);
      } finally {
        bytes[TOKEN_LEFT] = outer;
      }
    };
  };
  limitToken("parseRawInt", MAX_NUMBER_BYTES);
  limitToken("parseRawNumber", MAX_NUMBER_BYTES);
  limitToken("parseName", MAX_NAME_BYTES);
  limitToken("parseString", MAX_STRING_BYTES);
  limitToken("parseHexString", MAX_STRING_BYTES);

  // pdf-lib keeps a hex string as the chain of one-character concatenations it was read with
  // (about 32 bytes of heap per digit, for as long as the document lives); a copy through a
  // buffer is one flat string. Latin-1 is exact here: every character came from one byte.
  const parseHexString = method("parseHexString");
  parser.parseHexString = function (this: GuardedParser): unknown {
    const parsed = parseHexString.call(this) as PDFHexString;
    return PDFHexString.of(Buffer.from(parsed.asString(), "latin1").toString("latin1"));
  };
}

/**
 * The budget a byte stream belongs to. The streams of object and cross-reference streams are
 * attached where they are made (the `forStream` wrappers); any other one is the file itself and
 * belongs to the load that first touches it.
 */
function budgetOf(stream: GuardedStream): LoadBudget {
  const known = stream[BUDGET];
  if (known !== undefined) return known;
  // Outside withPdfLoadBudget (not used by this server) every stream gets the full limits.
  const budget = budgets.getStore() ?? newBudget(MAX_PDF_LOAD_INFLATED_BYTES, MAX_PDF_LOAD_VALUES);
  attach(stream, budget, STEPS_PER_BYTE);
  return budget;
}

/** Puts a byte stream under a budget and adds the steps its length allows. */
function attach(stream: GuardedStream, budget: LoadBudget, stepsPerByte: number): void {
  if (budget.violation === undefined) budget.steps += stepsPerByte * stream.length;
  stream[BUDGET] = budget;
  stream[TOKEN_LEFT] = Infinity;
}

/**
 * Ends a byte stream and records the violation. With the length at zero `done()` is true, so the
 * loops of pdf-lib that swallow the error (it skips an object it cannot parse and searches for
 * the next one) end at once instead of running into the limit again at every byte.
 */
function stop(stream: GuardedStream, budget: LoadBudget, reason: string): never {
  stream.length = 0;
  return violate(budget, reason);
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

/** PDF white space (ISO 32000-1, 7.2.2), the bytes pdf-lib skips between the header's integers. */
function isWhitespace(byte: number | undefined): boolean {
  return byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
}

function isDigit(byte: number | undefined): byte is number {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

/** An object number or offset in an object stream's header has at most this many digits. */
const MAX_HEADER_DIGITS = 10;

/**
 * Checks an object stream before pdf-lib parses it. `/N` against the data: each object needs at
 * least its header pair. Then the header itself, on the decoded bytes (review 2026-11, round 3):
 * `/N` pairs of object number and offset, plain digits separated by white space, ending at or
 * before `/First`; the offsets strictly increasing (ISO 32000-2, 7.5.7: "in increasing order")
 * and inside the data. pdf-lib seeks to `/First` + offset for every pair without looking at any
 * of this, so pairs that share an offset made it parse and keep the same bytes once per pair.
 * A header with comments, which pdf-lib would skip, is refused: then this check and pdf-lib read
 * the same integers.
 */
function checkObjectStreamShape(stream: PDFRawStream, data: Uint8Array, budget: LoadBudget): void {
  const malformed = (): never => violate(budget, "The PDF's object stream is malformed");
  const size = data.byteLength;
  const objects = integerOf(stream.dict.lookup(PDFName.of("N")));
  // "1 0 " is the shortest header pair: four bytes per object at least.
  if (objects === undefined || objects < 0 || objects * 4 > size) return malformed();
  countEntries(budget, objects);
  const first = integerOf(stream.dict.lookup(PDFName.of("First")));
  if (first === undefined || first < 0 || first > size) return malformed();

  let position = 0;
  const integer = (): number => {
    while (isWhitespace(data[position])) position += 1;
    const start = position;
    let value = 0;
    for (let byte = data[position]; isDigit(byte); byte = data[position]) {
      value = value * 10 + (byte - 0x30);
      position += 1;
      if (position - start > MAX_HEADER_DIGITS) return malformed();
    }
    if (position === start || position > first) return malformed();
    return value;
  };
  let previous = -1;
  for (let index = 0; index < objects; index += 1) {
    integer();
    const offset = integer();
    if (offset <= previous || first + offset >= size) return malformed();
    previous = offset;
  }
}

/**
 * Charges a stream's decoded size to the current budget; throws when it does not fit. Returns the
 * decoded bytes and the budget they were charged to.
 */
function charge(stream: PDFRawStream): { data: Uint8Array; budget: LoadBudget } {
  // Outside withPdfLoadBudget (not used by this server) every stream gets the full limit.
  const budget = budgets.getStore() ?? newBudget(MAX_PDF_LOAD_INFLATED_BYTES, MAX_PDF_LOAD_VALUES);
  if (budget.violation !== undefined) throw new Error(budget.violation);
  const data = decoded(stream, budget);
  budget.remaining -= data.byteLength;
  return { data, budget };
}

/** The stream's bytes as pdf-lib will decode them, within what is left of the budget. */
function decoded(stream: PDFRawStream, budget: LoadBudget): Uint8Array {
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
    return contents;
  }
  if (filters[0] !== "FlateDecode" && filters[0] !== "Fl") {
    return violate(
      budget,
      "The PDF compresses its internal structure in a way this server does not read",
    );
  }
  // Decoded with zlib alone, never with a raw-deflate fallback: pdf-lib's decoder reads
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
    const data = inflateSync(contents, options);
    if (data.byteLength > budget.remaining) return violate(budget, tooLarge(budget.limit));
    return data;
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

/**
 * Records the load's first violation and takes away everything the load had left, so its parsers
 * stop at their next step (see {@link stop}); throws the first violation's reason.
 */
function violate(budget: LoadBudget, reason: string): never {
  budget.violation ??= reason;
  budget.remaining = 0;
  budget.values = 0;
  budget.steps = 0;
  throw new Error(budget.violation);
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
