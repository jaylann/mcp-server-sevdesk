/**
 * Shared parts of sevDesk's sales documents: invoices (Rechnungen), credit notes (Gutschriften)
 * and orders (Angebote, Auftragsbestätigungen, Lieferscheine). The three share most attributes
 * (spec tags `Invoice`, `CreditNote`, `Order`): positions (Positionen), totals, tax rule, status,
 * contact, address and send state. Their lenient parsing and DTO mapping live here once; the
 * per-document modules (`invoices.ts`, `credit-notes.ts`, `orders.ts`) add what is specific.
 *
 * Totals. Every document carries `sumNet`/`sumTax`/`sumGross` and, per the spec,
 * `sum…ForeignCurrency` ("sum of the invoice in the foreign currency"). Recorded EUR documents
 * (sevDesk.NET, sevdesk-rs) have `sumNet` = position sum and every `…ForeignCurrency` = "0", so
 * `sumNet`/`sumTax`/`sumGross` are the account (EUR) amounts and must never fall back to the
 * foreign fields. sevDesk's own web app shows `…ForeignCurrency` sums when a document's currency
 * differs from the account currency and formats `sumNet`/`sumGross` in the account currency, so a
 * document in another currency reports both (see {@link splitTotals}); no public recording of a
 * foreign-currency document exists yet. `sum…Accounting` ("usually the same as sumNet") is not
 * used. Amounts stay exact decimal strings.
 *
 * All text from sevDesk is untrusted and goes through `sanitizeUntrusted` (via {@link cleanText}).
 */
import { z } from "zod";

import { toBerlinDate } from "../sevdesk/dates.js";
import { SevdeskError } from "../sevdesk/errors.js";
import {
  parseUpstream,
  zBool01,
  zId,
  zIntish,
  zOptionalDecimal,
  zOptionalInt,
  zOptionalRef,
  zText,
} from "../sevdesk/schema.js";
import { detectGeneration } from "../sevdesk/system-version.js";
import type { QueryValue, SevdeskClient } from "../sevdesk/types.js";
import {
  cleanText,
  compact,
  currencyCode,
  moneyFromUpstream,
  moneySchema,
  splitTotals,
  type SumFields,
} from "./common.js";
import { parseContactRecord, toContactDto } from "./contacts.js";
import { compare } from "./money.js";
import { listChildRows, pageOutput, pageSummary, readPage } from "./paging.js";
import { listUnits, taxRuleById } from "./reference-data.js";

// The lenient field helpers and the DTO helpers shared with other modules live in
// `sevdesk/schema.ts` and `common.ts`; they are re-exported here so the sales-document modules
// import their building blocks from one place.
export { zOptionalDecimal, zOptionalInt, zOptionalRef, zText } from "../sevdesk/schema.js";
export { cleanText, compact, splitTotals, statusDto, statusDtoSchema } from "./common.js";

/** Caps for untrusted text fields. */
export const TEXT_MAX = {
  name: 300,
  short: 200,
  long: 2_000,
} as const;

// ---------------------------------------------------------------------------------------------
// Lenient upstream field helpers
// ---------------------------------------------------------------------------------------------

/** Optional "0"/"1" boolean. */
export const zOptionalBool = zBool01.optional();

/** A date-time, Unix timestamp or `dd.mm.yyyy`; mapped with {@link berlinDate}. */
export const zDateValue = z.unknown().optional();

/** Fields every sales document has (the subset the DTOs need). */
export const salesDocumentFields = {
  id: zId,
  contact: z.unknown().optional(),
  create: zDateValue,
  update: zDateValue,
  header: zText,
  headText: zText,
  footText: zText,
  address: zText,
  /** Structured address parts; API-created documents may carry only these (`address` null). */
  addressName: zText,
  addressStreet: zText,
  addressZip: zText,
  addressCity: zText,
  addressCountry: zOptionalRef,
  status: zIntish,
  currency: zText,
  showNet: zOptionalBool,
  smallSettlement: zOptionalBool,
  contactPerson: z.unknown().optional(),
  taxRule: zOptionalRef,
  taxType: zText,
  taxText: zText,
  taxSet: zOptionalRef,
  sendDate: zDateValue,
  sendType: zText,
  customerInternalNote: zText,
  deliveryDate: zDateValue,
  deliveryDateUntil: zDateValue,
  sumNet: zOptionalDecimal,
  sumTax: zOptionalDecimal,
  sumGross: zOptionalDecimal,
  sumDiscounts: zOptionalDecimal,
  sumNetForeignCurrency: zOptionalDecimal,
  sumTaxForeignCurrency: zOptionalDecimal,
  sumGrossForeignCurrency: zOptionalDecimal,
  sumDiscountsForeignCurrency: zOptionalDecimal,
};

/** The shared fields of a parsed sales document record. */
export type SalesDocumentRecord = z.output<z.ZodObject<typeof salesDocumentFields>>;

// ---------------------------------------------------------------------------------------------
// Shared DTO parts
// ---------------------------------------------------------------------------------------------

/** Document type (Belegart) such as RE or AN. */
export const typeDtoSchema = z.object({
  key: z.string().optional().describe("Accepted type input/filter key; absent for unknown codes."),
  code: z.string(),
  label: z.string().describe("English meaning; German term in labelDe."),
  labelDe: z.string().optional(),
});

export const contactRefSchema = z.object({
  id: z.number().int().describe("Contact id; details via sevdesk_contact_get."),
  name: z
    .string()
    .optional()
    .describe("Organisation name or the person's full name, when sevDesk sent the contact."),
});

export type ContactRef = z.output<typeof contactRefSchema>;

/**
 * The document's contact: a plain `{id, objectName}` reference, or the whole contact when sevDesk
 * embedded it (`embed=contact`). The name follows the contacts module's rule (organisation name,
 * else the person's name parts).
 */
export function contactRef(raw: unknown): ContactRef | undefined {
  if (raw === null || raw === undefined) return undefined;
  const record = parseContactRecord(raw);
  const named = [record.name, record.surename, record.familyname, record.name2].some(
    (part) => part !== undefined && part.trim() !== "",
  );
  return named ? { id: record.id, name: toContactDto(record).displayName } : { id: record.id };
}

/** The id of an optional reference that may also arrive embedded (e.g. `contactPerson`). */
export function refId(raw: unknown, what: string): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  return parseUpstream(z.object({ id: zId }), raw, what).id;
}

/** Net, tax and gross of a document or position, all in one currency. */
const totalsSchema = z
  .object({
    net: moneySchema.optional().describe("Netto."),
    tax: moneySchema.optional().describe("Umsatzsteuer."),
    gross: moneySchema.optional().describe("Brutto."),
  })
  .meta({ id: "DocumentTotals" });

export const documentTotalsSchema = z.object({
  currency: z.string().length(3).describe("Document currency (ISO 4217)."),
  totals: totalsSchema.describe("Sums in the document currency."),
  totalsEur: totalsSchema
    .optional()
    .describe("Only for documents in another currency: the EUR sums sevDesk books."),
  discounts: moneySchema.optional().describe("Sum of document discounts (Rabatte), if any."),
});

export type DocumentTotals = z.output<typeof documentTotalsSchema>;

/** Document-level totals (see {@link splitTotals}). */
export function documentTotals(
  record: SumFields & {
    readonly currency?: string | undefined;
    readonly sumDiscounts?: string | undefined;
    readonly sumDiscountsForeignCurrency?: string | undefined;
  },
): DocumentTotals {
  const currency = currencyCode(record.currency);
  const { totals, eur } = splitTotals(record, currency);
  const discountAmount =
    eur === undefined ? record.sumDiscounts : record.sumDiscountsForeignCurrency;
  const discounts =
    discountAmount === undefined || compare(discountAmount, 0) === 0
      ? undefined
      : moneyFromUpstream(discountAmount, currency);
  return compact({ currency, totals, totalsEur: eur, discounts });
}

/** Tax setting of a document: Update 2.0 tax rule or the legacy (1.0) tax type. */
export const taxDtoSchema = z.object({
  generation: z
    .enum(["1.0", "2.0"])
    .optional()
    .describe("Bookkeeping generation of this document: 2.0 uses taxRule, 1.0 taxType."),
  rule: z
    .object({
      id: z.number().int(),
      code: z.string().optional(),
      name: z.string().optional().describe("German name (Steuerregel), if known."),
      documented: z.boolean().optional().describe("False: not in sevDesk's API docs."),
    })
    .optional()
    .describe("Update 2.0 tax rule (Steuerregel); see sevdesk_reference_lookup kind=tax_rules."),
  taxType: z.string().optional().describe("Update 1.0 tax type (default, eu, noteu, ss, custom)."),
  taxSetId: z.number().int().optional().describe("Update 1.0 custom tax set (taxType custom)."),
  text: z.string().optional().describe("Tax text printed on the document."),
  smallBusiness: z
    .boolean()
    .optional()
    .describe("Kleinunternehmerregelung (§19 UStG): no VAT on the document."),
});

export type TaxDto = z.output<typeof taxDtoSchema>;

/** The tax setting with the rule name from reference data and the generation per document. */
export function taxDto(record: SalesDocumentRecord): TaxDto {
  const generation = detectGeneration(record);
  const rule = record.taxRule === undefined ? undefined : taxRuleById(record.taxRule.id);
  return compact({
    generation,
    rule:
      record.taxRule === undefined
        ? undefined
        : rule === undefined
          ? { id: record.taxRule.id }
          : { id: rule.id, code: rule.code, name: rule.nameDe, documented: rule.documented },
    taxType: generation === "2.0" ? undefined : cleanText(record.taxType, TEXT_MAX.short),
    taxSetId: record.taxSet?.id,
    text: cleanText(record.taxText, TEXT_MAX.short),
    smallBusiness: record.smallSettlement,
  });
}

/** How a document was sent (Versandart), as the tools name it (`sentVia` in and out). */
export const SENT_VIA = ["pdf_download", "post", "print", "email"] as const;
export type SentVia = (typeof SENT_VIA)[number];

/**
 * sevDesk's `sendType` code of each send way (spec `invoiceSendBy`): `VPDF` downloaded PDF, `VP`
 * postal, `VPR` printed, `VM` mail (set by sevDesk's own email as well as recorded by hand).
 */
export const SEND_TYPE_CODES = {
  pdf_download: "VPDF",
  post: "VP",
  print: "VPR",
  email: "VM",
} as const satisfies Readonly<Record<SentVia, string>>;

const SENT_VIA_BY_CODE: ReadonlyMap<string, SentVia> = new Map(
  SENT_VIA.map((via) => [SEND_TYPE_CODES[via], via]),
);

export const sentDtoSchema = z.object({
  date: z.string().optional().describe("YYYY-MM-DD the document was sent."),
  via: z
    .enum(SENT_VIA)
    .optional()
    .describe(
      "pdf_download (downloaded as PDF), post (sent by post), print (printed), email (emailed, " +
        "through sevDesk or your own way).",
    ),
});

export type SentDto = z.output<typeof sentDtoSchema>;

/**
 * Send state, or `undefined` when not sent. sevDesk also sends `""` and `"0"` as `sendType` for
 * unsent documents (spec/deviations.md D-009); only the documented codes count.
 */
export function sentDto(record: SalesDocumentRecord): SentDto | undefined {
  const type = record.sendType?.trim().toUpperCase();
  const via = type === undefined ? undefined : SENT_VIA_BY_CODE.get(type);
  const date = berlinDate(record.sendDate);
  return date === undefined && via === undefined ? undefined : compact({ date, via });
}

/** How position prices were entered (`priceMode`), from `showNet`; `undefined` when unset. */
export function priceModeOf(showNet: boolean | undefined): "net" | "gross" | undefined {
  return showNet === undefined ? undefined : showNet ? "net" : "gross";
}

/**
 * The printed recipient address and its country; `undefined` when sevDesk sent neither. Documents
 * created through the API often have `address: null` and only the structured parts
 * (`addressName`, `addressStreet`, `addressZip`, `addressCity`); the text is then composed from
 * them, one line per part.
 */
export function addressDto(
  record: SalesDocumentRecord,
): { text?: string | undefined; countryId?: number | undefined } | undefined {
  const city = [record.addressZip, record.addressCity]
    .map((part) => part?.trim())
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  const composed = [record.addressName, record.addressStreet, city]
    .map((part) => part?.trim())
    .filter((part) => part !== undefined && part !== "")
    .join("\n");
  const address = compact({
    text: cleanText(record.address ?? (composed === "" ? undefined : composed), TEXT_MAX.long),
    countryId: record.addressCountry?.id,
  });
  return Object.keys(address).length === 0 ? undefined : address;
}

// ---------------------------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------------------------

/**
 * A position row (`InvoicePos`, `CreditNotePos`, `OrderPos`). Shape from the recorded
 * `GET /InvoicePos` (sevDesk.NET, 2026-02-19); credit note and order positions share the
 * attributes (spec `Model_creditNotePosResponse`, `Model_OrderPosResponse`).
 */
const positionRecordSchema = z.object({
  id: zId,
  invoice: zOptionalRef,
  creditNote: zOptionalRef,
  order: zOptionalRef,
  part: zOptionalRef,
  quantity: zOptionalDecimal,
  price: zOptionalDecimal,
  priceNet: zOptionalDecimal,
  priceGross: zOptionalDecimal,
  name: zText,
  text: zText,
  unity: zOptionalRef,
  positionNumber: zOptionalInt,
  discount: zOptionalDecimal,
  isPercentage: zOptionalBool,
  taxRate: zOptionalDecimal,
  optional: zOptionalBool,
  sumNet: zOptionalDecimal,
  sumTax: zOptionalDecimal,
  sumGross: zOptionalDecimal,
  sumNetForeignCurrency: zOptionalDecimal,
  sumTaxForeignCurrency: zOptionalDecimal,
  sumGrossForeignCurrency: zOptionalDecimal,
});

export type PositionRecord = z.output<typeof positionRecordSchema>;

export const positionDtoSchema = z.object({
  id: z.number().int(),
  number: z.number().int().optional().describe("Position number (sort order)."),
  name: z.string().optional().describe("Article or service name."),
  text: z.string().optional().describe("Position description."),
  partId: z.number().int().optional().describe("Inventory part (Artikel), if linked."),
  quantity: z.string().optional().describe("Exact decimal, e.g. '2' or '1.5'."),
  unit: z
    .object({ id: z.number().int(), name: z.string().optional() })
    .optional()
    .describe("Unit (Einheit), e.g. Stk, Std."),
  unitPriceNet: moneySchema.optional().describe("Price per unit, net."),
  unitPriceGross: moneySchema.optional().describe("Price per unit, gross."),
  taxRate: z.string().optional().describe("VAT rate in percent, e.g. '19'."),
  discount: z
    .object({ value: z.string(), isPercentage: z.boolean() })
    .optional()
    .describe("Position discount (Rabatt); left out when there is none."),
  totals: totalsSchema.optional().describe("Position sums in the document currency."),
  optional: z.boolean().optional().describe("Optional position (not part of the total)."),
});

export type PositionDto = z.output<typeof positionDtoSchema>;

/**
 * Maps a position. `showNet` is the document's flag: true means `price` was entered as net,
 * false as gross; it fills in whichever of `priceNet`/`priceGross` sevDesk left out.
 */
export function toPositionDto(
  record: PositionRecord,
  context: {
    readonly currency: string;
    readonly showNet: boolean | undefined;
    readonly unitNames: ReadonlyMap<number, string>;
  },
): PositionDto {
  const { currency, showNet } = context;
  const priceNet = record.priceNet ?? (showNet === true ? record.price : undefined);
  const priceGross = record.priceGross ?? (showNet === false ? record.price : undefined);
  const unitName = record.unity === undefined ? undefined : context.unitNames.get(record.unity.id);
  const { totals } = splitTotals(record, currency);
  const hasDiscount = record.discount !== undefined && compare(record.discount, 0) !== 0;
  return compact({
    id: record.id,
    number: record.positionNumber,
    name: cleanText(record.name, TEXT_MAX.name),
    text: cleanText(record.text, TEXT_MAX.long),
    partId: record.part?.id,
    quantity: record.quantity,
    unit:
      record.unity === undefined
        ? undefined
        : unitName === undefined || unitName === ""
          ? { id: record.unity.id }
          : { id: record.unity.id, name: unitName },
    unitPriceNet: moneyFromUpstream(priceNet, currency),
    unitPriceGross: moneyFromUpstream(priceGross, currency),
    taxRate: record.taxRate,
    discount:
      hasDiscount && record.discount !== undefined
        ? { value: record.discount, isPercentage: record.isPercentage ?? false }
        : undefined,
    totals: Object.keys(totals).length === 0 ? undefined : totals,
    optional: record.optional === true ? true : undefined,
  });
}

/** Where a document's positions live and how they point back to it. */
export interface PositionSource {
  /** Collection path, e.g. `/InvoicePos`. */
  readonly path: string;
  /** Reference field on the position, e.g. `invoice`. */
  readonly parentKey: "invoice" | "creditNote" | "order";
  /** `objectName` sent with the `<parentKey>[id]` filter, e.g. `Invoice`. */
  readonly objectName: string;
  /** Trusted noun for error messages, e.g. `invoice positions`. */
  readonly what: string;
}

export interface PositionRows {
  /** Sorted by position number, then id. */
  readonly rows: readonly PositionRecord[];
  /** False when the cap stopped reading before the end; `rows` is then partial. */
  readonly complete: boolean;
}

/**
 * Reads the positions of one document through the collection's `<parentKey>[id]` filter
 * (documented in the spec for `GET /InvoicePos`, `/CreditNotePos` and `/OrderPos`). Rows are
 * always also checked against their parent reference here, so an ignored filter cannot mix in
 * another document's positions; see {@link listChildRows} for paging and the cap.
 */
export async function listDocumentPositions(
  client: SevdeskClient,
  source: PositionSource,
  documentId: number,
  signal?: AbortSignal,
): Promise<PositionRows> {
  const { rows, complete } = await listChildRows(
    client,
    source.path,
    {
      [`${source.parentKey}[id]`]: documentId,
      [`${source.parentKey}[objectName]`]: source.objectName,
    },
    {
      parse: (raw) => parseUpstream(positionRecordSchema, raw, source.what),
      belongs: (row) => row[source.parentKey]?.id === documentId,
    },
    signal,
  );
  return { rows: sortPositions(rows), complete };
}

function sortPositions(rows: readonly PositionRecord[]): PositionRecord[] {
  return [...rows].sort(
    (a, b) =>
      (a.positionNumber ?? Number.MAX_SAFE_INTEGER) -
        (b.positionNumber ?? Number.MAX_SAFE_INTEGER) || a.id - b.id,
  );
}

/**
 * Unit names by id from `GET /Unity`, for position DTOs. Names are a convenience: if the list
 * cannot be read the positions keep their unit ids, so a sevDesk error here (other than a
 * cancellation) does not fail the whole document.
 */
export async function loadUnitNames(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<ReadonlyMap<number, string>> {
  try {
    const units = await listUnits(client, signal);
    return new Map(units.items.map((unit) => [unit.id, unit.name]));
  } catch (error) {
    if (!(error instanceof SevdeskError) || error.kind === "aborted") throw error;
    return new Map();
  }
}

// ---------------------------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------------------------

export interface DocumentListParams<T> {
  readonly client: SevdeskClient;
  /** Collection path, e.g. `/Invoice`. */
  readonly path: string;
  /** sevDesk filters (paging parameters are added by the client). */
  readonly query: Readonly<Record<string, QueryValue>>;
  readonly limit: number;
  readonly offset: number;
  /** Parses and maps one row; throws `unexpected_response` for a row that does not fit. */
  readonly map: (raw: unknown) => T;
  /** A filter sevDesk cannot apply, checked here on every mapped row. */
  readonly keep?: ((item: T) => boolean) | undefined;
  /**
   * A filter sevDesk applies itself, checked again on every mapped row to drop what its looser
   * bound let in (the date range, see `documentDateFilter`). Unlike `keep` it does not start a
   * scan: sevDesk's paging and total stay.
   */
  readonly recheck?: ((item: T) => boolean) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface DocumentListResult<T> {
  readonly items: readonly T[];
  /** Rows read from sevDesk, before the local filter. `nextOffset` = offset + received. */
  readonly received: number;
  /** All rows matching sevDesk's filters (`countAll`); `undefined` with a local filter. */
  readonly total: number | undefined;
  readonly hasMore: boolean;
  readonly nextOffset: number;
  /** True when `keep` filtered rows here. */
  readonly filteredLocally: boolean;
}

/**
 * Local re-check of an exact document-number filter (`invoiceNumber`, `creditNoteNumber`,
 * `orderNumber`). sevDesk silently ignores filters it does not understand (measured by the
 * sevdesk-rs project) and does not document how its number filters match, so every returned row
 * is compared here as well: trimmed, case-insensitive. `undefined` when no number was asked for.
 */
export function matchesNumber(
  number: string | undefined,
): ((row: { readonly number?: string | undefined }) => boolean) | undefined {
  if (number === undefined) return undefined;
  const wanted = number.trim().toLowerCase();
  return (row) => row.number?.trim().toLowerCase() === wanted;
}

/** All given local filters at once; `undefined` when none is given (no local filtering). */
export function allOf<T>(
  ...filters: readonly (((item: T) => boolean) | undefined)[]
): ((item: T) => boolean) | undefined {
  const active = filters.filter((filter): filter is (item: T) => boolean => filter !== undefined);
  if (active.length === 0) return undefined;
  return (item) => active.every((filter) => filter(item));
}

/**
 * Rows read per request while a local filter scans for matches: at least this many, or `limit`
 * when that is larger (callers that page through everything, such as reports, then need no more
 * requests than without the filter).
 */
const SCAN_PAGE_SIZE = 200;
/** Rows a single call may scan for matches of a local filter before it hands back control. */
export const SCAN_MAX_ROWS = 1_000;

/**
 * One page of a document list. Without a local filter this is one request of `limit` rows (the
 * next page starts at `offset + received`, see `paging.ts`). With `keep`, rows are read in chunks
 * from `offset` and checked here until `limit` matches are found, the list ends or
 * {@link SCAN_MAX_ROWS} rows were scanned; `nextOffset` then points right after the last row
 * scanned, so paging continues without gaps or repeats, and `total` is left out because sevDesk's
 * count does not reflect the local filter.
 */
export async function listDocuments<T>(
  params: DocumentListParams<T>,
): Promise<DocumentListResult<T>> {
  const { path, query, limit, offset, map, keep, signal } = params;
  const recheck = params.recheck ?? (() => true);
  const withSignal = signal === undefined ? {} : { signal };

  if (keep === undefined) {
    const page = await readPage(params.client, path, query, { limit, offset }, map, signal);
    const { received, total } = page.window;
    const items = page.items.filter(recheck);
    return { items, received, total, ...page.state, filteredLocally: false };
  }

  const items: T[] = [];
  let scanned = 0;
  let ended = false;
  while (items.length < limit && scanned < SCAN_MAX_ROWS) {
    const page = await params.client.list(path, query, {
      limit: Math.min(Math.max(SCAN_PAGE_SIZE, limit), SCAN_MAX_ROWS - scanned),
      offset: offset + scanned,
      ...withSignal,
    });
    if (page.items.length === 0) {
      ended = true;
      break;
    }
    let consumed = 0;
    for (const raw of page.items) {
      consumed += 1;
      const item = map(raw);
      if (recheck(item) && keep(item)) items.push(item);
      if (items.length === limit) break;
    }
    scanned += consumed;
    if (page.total !== undefined && offset + scanned >= page.total) ended = true;
    if (ended) break;
  }
  const nextOffset = offset + scanned;
  return {
    items,
    received: scanned,
    total: undefined,
    hasMore: !ended,
    nextOffset,
    filteredLocally: true,
  };
}

/** Output field of list tools that may filter locally; spread next to `pageOutputShape`. */
export const localFilterOutputShape = {
  filteredLocally: z
    .boolean()
    .optional()
    .describe(
      "True when a filter was applied by this server, not sevDesk: rows scanned are " +
        "offset to nextOffset, and total is left out.",
    ),
};

/** The page fields of a list tool's output (`items` plus `pageOutputShape`/local filter). */
export function documentListData<T>(
  result: DocumentListResult<T>,
  args: { readonly limit: number; readonly offset: number },
): {
  items: T[];
  total?: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
  filteredLocally?: boolean;
} {
  const window = { offset: args.offset, received: result.received, total: result.total };
  return {
    items: [...result.items],
    ...pageOutput(window, result, args.limit),
    ...(result.filteredLocally ? { filteredLocally: true } : {}),
  };
}

/**
 * Trusted one-line summary of a list page. `noun` is a trusted plural ("Invoices"); `matchNoun`
 * names what a local filter keeps ("overdue invoices").
 */
export function documentListSummary<T>(
  noun: string,
  matchNoun: string,
  result: DocumentListResult<T>,
  args: { readonly offset: number },
): string {
  const window = { offset: args.offset, received: result.received, total: result.total };
  if (!result.filteredLocally) return pageSummary(noun, window, result);
  const scanned =
    result.received === 0
      ? `no rows after offset ${args.offset}`
      : `rows ${args.offset + 1}–${result.nextOffset}`;
  const more = result.hasMore
    ? `; more may follow (nextOffset ${result.nextOffset})`
    : "; end of list";
  return (
    `${result.items.length} ${matchNoun} in ${scanned} (filtered by this server, not ` +
    `sevDesk)${more}.`
  );
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/**
 * Calendar date (Europe/Berlin) of a sevDesk date value. An unreadable date is an
 * `unexpected_response` error (never silently dropped).
 */
export function berlinDate(value: unknown): string | undefined {
  return toBerlinDate(value);
}

/** `YYYY-MM-DD` plus whole days (calendar arithmetic, no time zone involved). */
export function addDays(date: string, days: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
