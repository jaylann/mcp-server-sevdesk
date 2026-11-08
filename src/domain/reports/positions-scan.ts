/**
 * The position-level scan behind the tax reports (`sevdesk_vat_summary`,
 * `sevdesk_profit_and_loss`): which invoices (Rechnungen), credit notes (Gutschriften) and vouchers
 * (Belege) count, and what their positions add up to per VAT rate and booking account, in EUR.
 *
 * Two steps, so the expensive one stays bounded:
 * 1. **Headers** ({@link listDocumentHeaders}, {@link fetchDocumentHeader}): one list read per
 *    1,000 documents (`GET /Invoice`, `/CreditNote`, `/Voucher` with sevDesk's date filter, D-046),
 *    mapped with the detail mappers of the document modules, so tax rule, delivery dates, contact
 *    and EUR totals are known without positions. Drafts, recurring templates (WKR, RV) and
 *    reminders (MA, D-049) are counted and left out.
 * 2. **Positions** ({@link scanPositions}): one request per document (`GET /InvoicePos`,
 *    `/CreditNotePos`, `/VoucherPos` filtered by parent), at most {@link MAX_SCAN_DOCUMENTS}
 *    documents, a few in parallel (the client paces them), with progress and cancellation.
 *
 * Amounts. Positions give the composition (rate, account, asset flag); the document's EUR totals
 * give the amounts. When the positions add up to the document's totals they are used as they are;
 * otherwise (document discounts, foreign-currency positions without EUR sums, rounding) the
 * document's EUR net and tax are split over the position groups in proportion, so the report
 * always matches the documents' own sums. Foreign-currency documents count with sevDesk's EUR
 * values (D-043); one without any EUR value cannot be converted and is listed instead. Optional
 * positions are not part of a document's total and are skipped.
 *
 * Signs. Invoices count as revenue as they are (a cancellation invoice, SR, has negative sums and
 * offsets its original, D-037). A credit note reduces revenue (negative), unless its tax rule is an
 * expense rule: then it is a self-billed credit note to a supplier (Gutschrift im
 * umsatzsteuerlichen Sinne, e.g. a commission) and counts as an expense. Vouchers follow
 * `creditDebit` (C expense, D revenue).
 *
 * All text from sevDesk (numbers, names, VAT ids) is sanitized by the document mappers or here.
 */
import { berlinDateOf } from "../../sevdesk/dates.js";
import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../../sevdesk/paths.js";
import type { QueryValue, SevdeskClient } from "../../sevdesk/types.js";
import { cleanText, documentDateFilter } from "../common.js";
import { parseContactRecord, toContactDto } from "../contacts.js";
import { mapCreditNoteDetail } from "../credit-notes.js";
import { listDocumentPositions, type PositionRecord, splitTotals } from "../document-positions.js";
import { mapInvoiceDetail } from "../invoices.js";
import {
  add,
  compare,
  type Decimal,
  decimal,
  DEFAULT_CURRENCY,
  isZero,
  type Money,
  negate,
  subtract,
  toDecimalString,
} from "../money.js";
import { readPage } from "../paging.js";
import type {
  DocumentPayment,
  PaymentsInPeriodOptions,
  PaymentsInPeriodResult,
} from "../reconciliation/transaction-log.js";
import { taxRuleById } from "../reference-data.js";
import { listVoucherPositions, mapVoucherDetail, type VoucherPositionDto } from "../vouchers.js";
import { type ReportRunOptions, scanPages, throwIfAborted } from "./shared.js";

/** Most documents whose positions one report reads; more are reported as truncated. */
export const MAX_SCAN_DOCUMENTS = 1_500;
/** Most document rows (headers) one report lists across invoices, credit notes and vouchers. */
const MAX_HEADER_ROWS = 10_000;
/** Position reads in flight at once (the client paces them anyway). */
const POSITION_CONCURRENCY = 4;
const NUMBER_MAX = 100;
const VAT_ID_MAX = 30;

// ---------------------------------------------------------------------------------------------
// Payments (cash basis)
// ---------------------------------------------------------------------------------------------

/**
 * The cash-basis payments come from the bank reconciliation log (`paymentsInPeriod` in
 * `src/domain/reconciliation/transaction-log.ts`); the reports use its types as they are.
 */
export type { DocumentPayment, PaymentsInPeriodResult };

/** Document types a payment can settle. */
export type PaidDocumentObjectName = DocumentPayment["document"]["objectName"];

/** The cash-basis source: payments with a value date in `range` (inclusive). */
export type PaymentsInPeriod = (
  client: SevdeskClient,
  range: { readonly from: string; readonly to: string },
  options?: PaymentsInPeriodOptions,
) => Promise<PaymentsInPeriodResult>;

/**
 * A `voucherDirection` for `paymentsInPeriod` from headers already listed (expense vouchers pay
 * out, revenue vouchers receive), so it does not read those vouchers again.
 */
export function voucherDirections(
  headers: Iterable<DocumentHeader>,
): (voucherId: number) => "in" | "out" | undefined {
  const directions = new Map<number, "in" | "out">();
  for (const header of headers) {
    if (header.kind !== "voucher" || header.direction === undefined) continue;
    directions.set(header.id, header.direction === "expense" ? "out" : "in");
  }
  return (voucherId) => directions.get(voucherId);
}

// ---------------------------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------------------------

const SCAN_DOCUMENT_KINDS = ["invoice", "credit_note", "voucher"] as const;
type ScanDocumentKind = (typeof SCAN_DOCUMENT_KINDS)[number];

const OBJECT_NAMES: Readonly<Record<ScanDocumentKind, PaidDocumentObjectName>> = {
  invoice: "Invoice",
  credit_note: "CreditNote",
  voucher: "Voucher",
};

/** Revenue (Einnahme) or expense (Ausgabe), the direction of a document's amounts. */
type Direction = "revenue" | "expense";

/** Why a listed document does not count. */
type ExclusionReason = "draft" | "recurring_template" | "reminder" | "unknown_direction";

/** Net, tax and gross in EUR as exact decimals (unsigned: as sevDesk shows them). */
interface EurTotals {
  readonly net: Decimal;
  readonly tax: Decimal;
  readonly gross: Decimal;
}

/** What the reports need to know about one document before reading its positions. */
export interface DocumentHeader {
  readonly kind: ScanDocumentKind;
  readonly id: number;
  /** Rechnungs-/Gutschriftsnummer or Belegnummer, sanitized. */
  readonly number?: string | undefined;
  readonly statusCode: number;
  /** Invoices: RE, SR, AR, … */
  readonly invoiceType?: string | undefined;
  /** Document date (Rechnungs-/Gutschrifts-/Belegdatum), YYYY-MM-DD. */
  readonly date?: string | undefined;
  readonly deliveryDate?: string | undefined;
  readonly deliveryDateUntil?: string | undefined;
  readonly payDate?: string | undefined;
  readonly currency: string;
  /** Update 2.0 tax rule; for Update 1.0 documents mapped from an unambiguous legacy tax type. */
  readonly taxRuleId?: number | undefined;
  /**
   * Update 1.0 tax type (`default`, `eu`, `noteu`, `ss`, `custom`, lower case) of a document
   * without an Update 2.0 tax rule; `taxRuleId` is set only when the type maps to one rule.
   */
  readonly legacyTaxType?: string | undefined;
  readonly direction: Direction | undefined;
  /** −1 for credit notes that reduce revenue; 1 otherwise. */
  readonly sign: 1 | -1;
  readonly contact?:
    { readonly id?: number | undefined; readonly name?: string | undefined } | undefined;
  /**
   * USt-IdNr. of the contact when sevDesk embedded it (invoices, credit notes); `null` when the
   * embedded contact has none, `undefined` when the contact was not embedded (look it up).
   */
  readonly contactVatId?: string | null | undefined;
  /** Address country (StaticCountry id) of an invoice or credit note. */
  readonly countryId?: number | undefined;
  /** EUR totals; `undefined` for a foreign-currency document sevDesk did not convert. */
  readonly eur: EurTotals | undefined;
  /** Gross in the document's currency (for the share a payment settles). */
  readonly gross: Decimal | undefined;
  readonly excluded?: ExclusionReason | undefined;
}

/** A document reference as the reports list it (no sevDesk text but the sanitized number). */
interface DocumentRef {
  readonly objectName: PaidDocumentObjectName;
  readonly id: number;
  readonly number?: string | undefined;
}

function refOf(header: DocumentHeader): DocumentRef {
  return header.number === undefined
    ? { objectName: OBJECT_NAMES[header.kind], id: header.id }
    : { objectName: OBJECT_NAMES[header.kind], id: header.id, number: header.number };
}

const EMBED_CONTACT = "contact";
const INVOICE_DRAFT = 100;
const CREDIT_NOTE_DRAFT = 100;
const VOUCHER_DRAFT = 50;

/**
 * Update 1.0 `taxType` → the Update 2.0 rule that replaces it, per direction (`TAX_RULES`), for
 * the types that mean one thing. `eu` is left out on purpose: it covers goods and services alike
 * (intra-EU supplies Kz 41 or § 18b services Kz 21; acquisitions Kz 89 or § 13b services Kz 46),
 * so such documents are reported as unmapped instead of guessed.
 */
const LEGACY_RULES: Readonly<Record<string, Partial<Record<Direction, number>>>> = {
  default: { revenue: 1, expense: 9 },
  noteu: { revenue: 17 },
  ss: { revenue: 11, expense: 10 },
};

/** The rule and the normalized legacy type of a document's tax setting. */
function taxSetting(
  ruleId: number | undefined,
  taxType: string | undefined,
  direction: Direction | undefined,
): { taxRuleId: number | undefined; legacyTaxType: string | undefined } {
  if (ruleId !== undefined) return { taxRuleId: ruleId, legacyTaxType: undefined };
  const legacy = taxType?.trim().toLowerCase();
  if (legacy === undefined || legacy === "")
    return { taxRuleId: undefined, legacyTaxType: undefined };
  return {
    taxRuleId: direction === undefined ? undefined : LEGACY_RULES[legacy]?.[direction],
    legacyTaxType: legacy,
  };
}

function moneyDecimal(value: Money | undefined): Decimal | undefined {
  return value === undefined ? undefined : decimal(value.amount);
}

function eurTotals(
  sums:
    | {
        readonly net?: Money | undefined;
        readonly tax?: Money | undefined;
        readonly gross?: Money | undefined;
      }
    | undefined,
): EurTotals | undefined {
  const net = moneyDecimal(sums?.net);
  if (net === undefined) return undefined;
  const tax = moneyDecimal(sums?.tax) ?? decimal(0);
  return { net, tax, gross: moneyDecimal(sums?.gross) ?? add(net, tax) };
}

/**
 * The USt-IdNr. of an embedded contact (`embed=contact`): the id, `null` when the embedded
 * contact has none, `undefined` for a plain reference (not embedded).
 */
function embeddedVatId(raw: unknown): string | null | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const contact = (raw as Record<string, unknown>)["contact"];
  if (typeof contact !== "object" || contact === null || !("vatNumber" in contact)) {
    return undefined;
  }
  return normalizeVatId(toContactDto(parseContactRecord(contact)).vatNumber) ?? null;
}

/** An USt-IdNr. upper case without spaces, dots or dashes; `undefined` when empty. */
export function normalizeVatId(value: string | undefined): string | undefined {
  const text = cleanText(value, VAT_ID_MAX)
    ?.toUpperCase()
    .replace(/[\s.\-/]/g, "");
  return text === undefined || text === "" ? undefined : text;
}

function invoiceHeader(raw: unknown, today: string): DocumentHeader {
  const dto = mapInvoiceDetail(raw, today);
  const foreign = dto.currency !== DEFAULT_CURRENCY;
  const type = dto.type.code;
  const tax = taxSetting(dto.tax.rule?.id, dto.tax.taxType, "revenue");
  return {
    kind: "invoice",
    id: dto.id,
    number: cleanText(dto.number, NUMBER_MAX),
    statusCode: dto.status.code,
    invoiceType: type,
    date: dto.date,
    deliveryDate: dto.deliveryDate,
    deliveryDateUntil: dto.deliveryDateUntil,
    payDate: dto.payDate,
    currency: dto.currency,
    ...tax,
    direction: "revenue",
    sign: 1,
    contact: dto.contact,
    contactVatId: embeddedVatId(raw),
    countryId: dto.address?.countryId,
    eur: eurTotals(foreign ? dto.totalsEur : dto.totals),
    gross: moneyDecimal(dto.totals.gross),
    excluded:
      type === "WKR" || dto.status.code === 50
        ? "recurring_template"
        : type === "MA"
          ? "reminder"
          : dto.status.code === INVOICE_DRAFT
            ? "draft"
            : undefined,
  };
}

function creditNoteHeader(raw: unknown): DocumentHeader {
  const dto = mapCreditNoteDetail(raw);
  const foreign = dto.currency !== DEFAULT_CURRENCY;
  const rule = dto.tax.rule === undefined ? undefined : taxRuleById(dto.tax.rule.id);
  // A credit note under an expense rule is self-billed to a supplier: an expense, not a refund.
  const direction: Direction = rule?.direction === "expense" ? "expense" : "revenue";
  const tax = taxSetting(dto.tax.rule?.id, dto.tax.taxType, direction);
  return {
    kind: "credit_note",
    id: dto.id,
    number: cleanText(dto.number, NUMBER_MAX),
    statusCode: dto.status.code,
    date: dto.date,
    deliveryDate: dto.deliveryDate,
    deliveryDateUntil: dto.deliveryDateUntil,
    payDate: dto.payDate,
    currency: dto.currency,
    ...tax,
    direction,
    sign: direction === "revenue" ? -1 : 1,
    contact: dto.contact,
    contactVatId: embeddedVatId(raw),
    countryId: dto.address?.countryId,
    eur: eurTotals(foreign ? dto.totalsEur : dto.totals),
    gross: moneyDecimal(dto.totals.gross),
    excluded: dto.status.code === CREDIT_NOTE_DRAFT ? "draft" : undefined,
  };
}

function voucherHeader(raw: unknown): DocumentHeader {
  const dto = mapVoucherDetail(raw);
  const foreign = dto.currency !== DEFAULT_CURRENCY;
  const direction: Direction | undefined = dto.kind;
  const tax = taxSetting(dto.taxRule?.id, dto.taxType, direction);
  const totals = { net: dto.net, tax: dto.tax, gross: dto.gross };
  return {
    kind: "voucher",
    id: dto.id,
    number: cleanText(dto.number, NUMBER_MAX),
    statusCode: dto.status?.code ?? 0,
    date: dto.date,
    deliveryDate: dto.deliveryDate,
    deliveryDateUntil: dto.deliveryDateUntil,
    payDate: dto.payDate,
    currency: dto.currency,
    ...tax,
    direction,
    sign: 1,
    contact: dto.supplier,
    eur: eurTotals(foreign ? dto.base : totals),
    gross: moneyDecimal(dto.gross),
    excluded:
      dto.type === "recurring"
        ? "recurring_template"
        : dto.status?.code === VOUCHER_DRAFT
          ? "draft"
          : direction === undefined
            ? "unknown_direction"
            : undefined,
  };
}

interface KindSource {
  readonly path: string;
  readonly noun: string;
  readonly query: Readonly<Record<string, QueryValue>>;
  readonly map: (raw: unknown, today: string) => DocumentHeader;
}

const SOURCES: Readonly<Record<ScanDocumentKind, KindSource>> = {
  invoice: {
    path: "/Invoice",
    noun: "invoices",
    query: { embed: EMBED_CONTACT },
    map: invoiceHeader,
  },
  credit_note: {
    path: "/CreditNote",
    noun: "credit notes",
    query: { embed: EMBED_CONTACT },
    map: (raw) => creditNoteHeader(raw),
  },
  // Normal vouchers only (VOU); an RV row sevDesk returns anyway is dropped by `excluded`.
  voucher: {
    path: "/Voucher",
    noun: "vouchers",
    query: { voucherType: "VOU" },
    map: (raw) => voucherHeader(raw),
  },
};

export interface HeaderListParams {
  /** Document dates to read, inclusive (YYYY-MM-DD). */
  readonly from: string;
  readonly to: string;
  readonly kinds?: readonly ScanDocumentKind[] | undefined;
  /** Row cap across all kinds; defaults to {@link MAX_HEADER_ROWS}. */
  readonly maxRows?: number | undefined;
  /** Berlin `YYYY-MM-DD` for the invoice mapper's `overdue` (irrelevant here); tests pin it. */
  readonly today?: string | undefined;
}

export interface HeaderList {
  /** Documents that count, sorted by date, kind and id (kinds interleaved). */
  readonly headers: readonly DocumentHeader[];
  /** Listed documents left out, by reason. */
  readonly excluded: Readonly<Record<ExclusionReason, number>>;
  /** sevDesk rows read. */
  readonly rowsRead: number;
  /** True when the row cap stopped reading while more rows existed. */
  readonly truncated: boolean;
}

/**
 * Lists the documents dated `from`–`to` (document date; sevDesk filters with `startDate`/`endDate`
 * and every row is re-checked here, D-046) of the given kinds, mapped to headers. Drafts, templates
 * and reminders are counted in `excluded` and not returned.
 */
export async function listDocumentHeaders(
  client: SevdeskClient,
  params: HeaderListParams,
  options: ReportRunOptions = {},
): Promise<HeaderList> {
  const dates = documentDateFilter({ from: params.from, to: params.to });
  const today = params.today ?? berlinDateOf(Date.now());
  const max = params.maxRows ?? MAX_HEADER_ROWS;
  const excluded: Record<ExclusionReason, number> = {
    draft: 0,
    recurring_template: 0,
    reminder: 0,
    unknown_direction: 0,
  };
  const headers: DocumentHeader[] = [];
  let rowsRead = 0;
  let truncated = false;
  for (const kind of params.kinds ?? SCAN_DOCUMENT_KINDS) {
    const source = SOURCES[kind];
    if (max - rowsRead <= 0) {
      truncated = true;
      break;
    }
    const scan = await scanPages(
      async (offset, limit) => {
        const page = await readPage(
          client,
          source.path,
          { ...source.query, ...dates.query },
          { limit, offset },
          (raw) => source.map(raw, today),
          options.signal,
        );
        return {
          items: page.items.filter((header) => dates.contains(header.date)),
          received: page.window.received,
          total: page.window.total,
          hasMore: page.state.hasMore,
          nextOffset: page.state.nextOffset,
        };
      },
      {
        max: max - rowsRead,
        noun: source.noun,
        alreadyScanned: rowsRead,
        signal: options.signal,
        onProgress: options.onProgress,
      },
    );
    rowsRead += scan.scanned;
    truncated ||= scan.truncated;
    for (const header of scan.items) {
      if (header.excluded === undefined) headers.push(header);
      else excluded[header.excluded] += 1;
    }
  }
  return { headers: sortHeaders(headers), excluded, rowsRead, truncated };
}

/**
 * One document's header by id (`GET /Invoice/{id}`, `/CreditNote/{id}` with the contact embedded,
 * `/Voucher/{id}`), for documents a payment points to. A missing document is the client's
 * `not_found` error.
 */
export async function fetchDocumentHeader(
  client: SevdeskClient,
  ref: { readonly objectName: PaidDocumentObjectName; readonly id: number },
  signal?: AbortSignal,
  today: string = berlinDateOf(Date.now()),
): Promise<DocumentHeader> {
  const kind = kindOfObjectName(ref.objectName);
  const source = SOURCES[kind];
  const id = toSevdeskId(ref.id);
  const payload = await client.request({
    method: "GET",
    path: sevdeskPath(ref.objectName, id),
    ...(kind === "voucher" ? {} : { query: { embed: EMBED_CONTACT } }),
    ...(signal === undefined ? {} : { signal }),
  });
  return source.map(expectSingle(payload, `${source.noun.slice(0, -1)} ${String(id)}`), today);
}

function kindOfObjectName(objectName: PaidDocumentObjectName): ScanDocumentKind {
  return objectName === "Invoice"
    ? "invoice"
    : objectName === "CreditNote"
      ? "credit_note"
      : "voucher";
}

function sortHeaders(headers: DocumentHeader[]): DocumentHeader[] {
  const order = (kind: ScanDocumentKind): number => SCAN_DOCUMENT_KINDS.indexOf(kind);
  // By date first, so a cap on the positions read cuts the latest documents of every kind
  // instead of all vouchers (which would bias the input VAT and Kz 83).
  return headers.sort(
    (a, b) =>
      (a.date ?? "").localeCompare(b.date ?? "") || order(a.kind) - order(b.kind) || a.id - b.id,
  );
}

// ---------------------------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------------------------

/** One group of a document's positions in EUR, signed (see the module doc). */
export interface PositionGroup {
  /** VAT rate in percent as an exact decimal string, e.g. "19", "7", "0", "16". */
  readonly rate: string;
  readonly net: Decimal;
  readonly tax: Decimal;
  /** Update 2.0 booking account (vouchers). */
  readonly accountDatevId?: number | undefined;
  /** Update 1.0 booking account (vouchers). */
  readonly accountingTypeId?: number | undefined;
  /** Anlagegut. */
  readonly isAsset: boolean;
}

export interface ScannedDocument {
  readonly header: DocumentHeader;
  readonly groups: readonly PositionGroup[];
  /** False when sevDesk had more position rows than could be read. */
  readonly positionsComplete: boolean;
  /** True when the document's EUR totals were split over the groups in proportion. */
  readonly adjusted: boolean;
  /** True when the document had no positions and the rate was derived from its totals. */
  readonly derivedRate: boolean;
}

export interface PositionScan {
  readonly documents: readonly ScannedDocument[];
  /** Documents not read because of the cap (in input order, after the first `max`). */
  readonly notRead: number;
  /** Foreign-currency documents without EUR values (left out). */
  readonly unconvertible: readonly DocumentRef[];
}

export interface PositionScanOptions extends ReportRunOptions {
  /** Defaults to {@link MAX_SCAN_DOCUMENTS}. */
  readonly maxDocuments?: number | undefined;
}

interface RawPosition {
  readonly rate: string;
  readonly own: { readonly net: Decimal; readonly tax: Decimal };
  readonly eur: { readonly net: Decimal; readonly tax: Decimal } | undefined;
  readonly accountDatevId?: number | undefined;
  readonly accountingTypeId?: number | undefined;
  readonly isAsset: boolean;
}

/**
 * Reads the positions of `headers` (in the given order, the first `maxDocuments`), at most
 * {@link POSITION_CONCURRENCY} at a time, and returns each document's position groups in EUR.
 * Reports progress per document and stops with an `aborted` error when `signal` fires.
 */
export async function scanPositions(
  client: SevdeskClient,
  headers: readonly DocumentHeader[],
  options: PositionScanOptions = {},
): Promise<PositionScan> {
  const max = options.maxDocuments ?? MAX_SCAN_DOCUMENTS;
  const unconvertible = headers.filter((header) => header.eur === undefined).map(refOf);
  const convertible = headers.filter((header) => header.eur !== undefined);
  const selected = convertible.slice(0, max);
  let done = 0;
  const documents = await mapLimited(
    selected,
    POSITION_CONCURRENCY,
    async (header) => {
      const read = await readPositions(client, header, options.signal);
      done += 1;
      await options.onProgress?.(
        done,
        selected.length,
        `Read the positions of ${String(done)} of ${String(selected.length)} documents.`,
      );
      return toScannedDocument(header, read.positions, read.complete);
    },
    options.signal,
  );
  return { documents, notRead: convertible.length - selected.length, unconvertible };
}

async function readPositions(
  client: SevdeskClient,
  header: DocumentHeader,
  signal: AbortSignal | undefined,
): Promise<{ positions: RawPosition[]; complete: boolean }> {
  if (header.kind === "voucher") {
    const result = await listVoucherPositions(client, header.id, header.currency, signal);
    return { positions: result.positions.map(voucherPosition), complete: result.complete };
  }
  const source =
    header.kind === "invoice"
      ? {
          path: "/InvoicePos",
          parentKey: "invoice" as const,
          objectName: "Invoice",
          what: "invoice positions",
        }
      : {
          path: "/CreditNotePos",
          parentKey: "creditNote" as const,
          objectName: "CreditNote",
          what: "credit note positions",
        };
  const rows = await listDocumentPositions(client, source, header.id, signal);
  return {
    positions: rows.rows
      .filter((row) => row.optional !== true)
      .map((row) => salesPosition(row, header.currency)),
    complete: rows.complete,
  };
}

function salesPosition(row: PositionRecord, currency: string): RawPosition {
  const { totals, eur } = splitTotals(row, currency);
  const pick = (sums: typeof totals | undefined) =>
    sums === undefined
      ? undefined
      : {
          net: moneyDecimal(sums.net) ?? decimal(0),
          tax: moneyDecimal(sums.tax) ?? decimal(0),
        };
  const own = pick(totals) ?? { net: decimal(0), tax: decimal(0) };
  return {
    rate: normalizeRate(row.taxRate),
    own,
    eur: currency === DEFAULT_CURRENCY ? own : pick(eur),
    isAsset: false,
  };
}

function voucherPosition(position: VoucherPositionDto): RawPosition {
  const own = {
    net: moneyDecimal(position.net) ?? decimal(0),
    tax: moneyDecimal(position.tax) ?? decimal(0),
  };
  const foreign = position.net !== undefined && position.net.currency !== DEFAULT_CURRENCY;
  const base =
    position.base === undefined
      ? undefined
      : {
          net: moneyDecimal(position.base.net) ?? decimal(0),
          tax: moneyDecimal(position.base.tax) ?? decimal(0),
        };
  return {
    rate: normalizeRate(position.taxRate === undefined ? undefined : String(position.taxRate)),
    own,
    eur: foreign ? base : own,
    accountDatevId: position.accountDatev?.id,
    accountingTypeId: position.accountingType?.id,
    isAsset: position.isAsset === true,
  };
}

/** "19.00" → "19"; a missing or unreadable rate becomes "0". */
export function normalizeRate(rate: string | undefined): string {
  if (rate === undefined || rate.trim() === "") return "0";
  try {
    return toDecimalString(decimal(rate.trim()));
  } catch {
    throw new SevdeskError({
      kind: "unexpected_response",
      message: "sevDesk returned a tax rate that is not a number.",
    });
  }
}

interface GroupDraft {
  readonly rate: string;
  readonly accountDatevId?: number | undefined;
  readonly accountingTypeId?: number | undefined;
  readonly isAsset: boolean;
  net: Decimal;
  tax: Decimal;
}

/**
 * Groups a document's positions (rate, account, asset flag) and makes them add up to the
 * document's EUR totals, signed.
 */
function toScannedDocument(
  header: DocumentHeader,
  positions: readonly RawPosition[],
  complete: boolean,
): ScannedDocument {
  const eur = header.eur;
  // scanPositions never passes an unconvertible header.
  if (eur === undefined) throw new Error("toScannedDocument: header without EUR totals.");
  const inEur = positions.length > 0 && positions.every((position) => position.eur !== undefined);
  const groups = new Map<string, GroupDraft>();
  for (const position of positions) {
    const amounts = inEur && position.eur !== undefined ? position.eur : position.own;
    const key = [
      position.rate,
      position.accountDatevId ?? "",
      position.accountingTypeId ?? "",
      position.isAsset ? "asset" : "",
    ].join("|");
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        rate: position.rate,
        accountDatevId: position.accountDatevId,
        accountingTypeId: position.accountingTypeId,
        isAsset: position.isAsset,
        net: decimal(0),
        tax: decimal(0),
      };
      groups.set(key, group);
    }
    group.net = add(group.net, amounts.net);
    group.tax = add(group.tax, amounts.tax);
  }

  let drafts = [...groups.values()];
  let derivedRate = false;
  if (drafts.length === 0) {
    derivedRate = true;
    drafts = [{ rate: derivedRateOf(eur), isAsset: false, net: eur.net, tax: eur.tax }];
  }
  const netSum = drafts.reduce((sum, group) => add(sum, group.net), decimal(0));
  const taxSum = drafts.reduce((sum, group) => add(sum, group.tax), decimal(0));
  const exact = inEur && compare(netSum, eur.net) === 0 && compare(taxSum, eur.tax) === 0;
  let nets = drafts.map((group) => group.net);
  let taxes = drafts.map((group) => group.tax);
  if (!exact && !derivedRate) {
    nets = allocate(eur.net, nets, nets);
    taxes = allocate(eur.tax, taxes, nets);
  }
  const signed = (value: Decimal): Decimal => (header.sign < 0 ? negate(value) : value);
  return {
    header,
    groups: drafts.map((group, index) => ({
      rate: group.rate,
      net: signed(nets[index] ?? decimal(0)),
      tax: signed(taxes[index] ?? decimal(0)),
      ...(group.accountDatevId === undefined ? {} : { accountDatevId: group.accountDatevId }),
      ...(group.accountingTypeId === undefined ? {} : { accountingTypeId: group.accountingTypeId }),
      isAsset: group.isAsset,
    })),
    positionsComplete: complete,
    adjusted: !exact && !derivedRate,
    derivedRate,
  };
}

const STANDARD_RATES = ["19", "7", "0"] as const;

/** The rate of a document without positions: tax ÷ net, snapped to 19/7/0 within 0.1 points. */
function derivedRateOf(eur: EurTotals): string {
  if (isZero(eur.net)) return "0";
  const percent = ratioOf(eur.tax, decimal(100), eur.net, 2);
  for (const rate of STANDARD_RATES) {
    const difference = subtract(percent, rate);
    if (compare(difference, "0.1") <= 0 && compare(difference, "-0.1") >= 0) return rate;
  }
  return toDecimalString(percent);
}

// ---------------------------------------------------------------------------------------------
// Exact arithmetic helpers
// ---------------------------------------------------------------------------------------------

/**
 * `amount × part ÷ whole`, rounded half away from zero to `places` decimals ("kaufmännisch"),
 * computed exactly on bigints (money.ts has no division). `whole` must not be zero.
 */
export function ratioOf(amount: Decimal, part: Decimal, whole: Decimal, places = 2): Decimal {
  if (whole.units === 0n) throw new Error("ratioOf: division by zero.");
  const numerator = amount.units * part.units * 10n ** BigInt(whole.scale + places);
  const denominator = whole.units * 10n ** BigInt(amount.scale + part.scale);
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let quotient = n / d;
  if ((n % d) * 2n >= d) quotient += 1n;
  return decimal({ units: negative ? -quotient : quotient, scale: places });
}

/** `base × rate %`, rounded to cents. */
export function percentOf(base: Decimal, rate: string): Decimal {
  return ratioOf(base, decimal(rate), decimal(100));
}

/**
 * Splits `total` over entries in proportion to `weights` (rounded to cents; the last entry with
 * a weight takes the remainder, so the parts add up exactly). When all weights are zero, the
 * `fallback` weights are used; when those are zero too, the first entry takes everything.
 */
export function allocate(
  total: Decimal,
  weights: readonly Decimal[],
  fallback: readonly Decimal[],
): Decimal[] {
  const sumOf = (values: readonly Decimal[]): Decimal =>
    values.reduce((sum, value) => add(sum, value), decimal(0));
  let used = weights;
  if (isZero(sumOf(used))) used = fallback;
  const whole = sumOf(used);
  if (isZero(whole)) return used.map((_, index) => (index === 0 ? total : decimal(0)));
  const lastWeighted = used.reduce(
    (last, weight, index) => (isZero(weight) ? last : index),
    used.length - 1,
  );
  const parts = used.map((weight, index) =>
    index === lastWeighted || isZero(weight) ? decimal(0) : ratioOf(total, weight, whole),
  );
  parts[lastWeighted] = subtract(total, sumOf(parts));
  return parts;
}

/** Sum of exact decimals. */
export function sumOf(values: readonly Decimal[]): Decimal {
  return values.reduce((sum, value) => add(sum, value), decimal(0));
}

// ---------------------------------------------------------------------------------------------
// Paid documents (cash basis)
// ---------------------------------------------------------------------------------------------

/** `Invoice:1001`, the key reports use for a document. */
export function documentKey(ref: {
  readonly objectName: PaidDocumentObjectName;
  readonly id: number;
}): string {
  return `${ref.objectName}:${String(ref.id)}`;
}

/** The {@link documentKey} of a header. */
export function headerKey(header: DocumentHeader): string {
  return documentKey({ objectName: OBJECT_NAMES[header.kind], id: header.id });
}

export interface PaidDocuments {
  /** Documents with at least one counted payment, in the order of their first payment. */
  readonly headers: readonly DocumentHeader[];
  /** Counted payments per {@link documentKey}. */
  readonly payments: ReadonlyMap<string, readonly DocumentPayment[]>;
  readonly coverage: {
    readonly read: number;
    readonly used: number;
    readonly documentsFetched: number;
    readonly truncated: boolean;
  };
  /** Fetched documents left out, by reason. */
  readonly excluded: Readonly<Record<ExclusionReason, number>>;
  /** Trusted text: the payment source's notes plus what was skipped here. */
  readonly notes: readonly string[];
}

/**
 * Matches payments to their documents: headers already listed (`known`, by {@link documentKey})
 * are reused, the others are fetched by id ({@link POSITION_CONCURRENCY} at a time, at most
 * `maxFetches`, default {@link MAX_SCAN_DOCUMENTS}; payments on documents beyond the cap are left
 * out and the result is `truncated`). A payment counts when its document is not excluded, is
 * accepted by `accept`, and the payment is in the document's currency.
 */
export async function collectPaidDocuments(
  client: SevdeskClient,
  result: PaymentsInPeriodResult,
  options: {
    readonly known?: ReadonlyMap<string, DocumentHeader> | undefined;
    readonly accept: (header: DocumentHeader) => boolean;
    readonly maxFetches?: number | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly today?: string | undefined;
  },
): Promise<PaidDocuments> {
  const headers = new Map<string, DocumentHeader>(options.known ?? []);
  const excluded: Record<ExclusionReason, number> = {
    draft: 0,
    recurring_template: 0,
    reminder: 0,
    unknown_direction: 0,
  };

  // Documents to fetch, in payment order, up to the cap.
  const missing: { key: string; ref: DocumentPayment["document"] }[] = [];
  const seen = new Set<string>();
  for (const payment of result.payments) {
    const key = documentKey(payment.document);
    if (headers.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push({ key, ref: payment.document });
  }
  const maxFetches = options.maxFetches ?? MAX_SCAN_DOCUMENTS;
  const toFetch = missing.slice(0, maxFetches);
  const fetchedHeaders = await mapLimited(
    toFetch,
    POSITION_CONCURRENCY,
    (entry) => fetchDocumentHeader(client, entry.ref, options.signal, options.today),
    options.signal,
  );
  toFetch.forEach((entry, index) => {
    const header = fetchedHeaders[index] as DocumentHeader;
    headers.set(entry.key, header);
    if (header.excluded !== undefined) excluded[header.excluded] += 1;
  });

  const payments = new Map<string, DocumentPayment[]>();
  const order: DocumentHeader[] = [];
  let mismatched = 0;
  let skippedByCap = 0;
  let used = 0;
  for (const payment of result.payments) {
    const key = documentKey(payment.document);
    const header = headers.get(key);
    if (header === undefined) {
      skippedByCap += 1;
      continue;
    }
    if (header.excluded !== undefined || !options.accept(header)) continue;
    if (payment.amount.currency !== header.currency) {
      mismatched += 1;
      continue;
    }
    used += 1;
    const list = payments.get(key);
    if (list === undefined) {
      payments.set(key, [payment]);
      order.push(header);
    } else {
      list.push(payment);
    }
  }
  const notes = [...result.notes];
  if (mismatched > 0) {
    notes.push(
      `${mismatched === 1 ? "1 payment" : `${String(mismatched)} payments`} in another currency ` +
        "than the document were left out.",
    );
  }
  if (skippedByCap > 0) {
    notes.push(
      `${String(skippedByCap)} payment(s) on documents beyond the cap of ${String(maxFetches)} ` +
        "documents read by id were left out: the figures are incomplete.",
    );
  }
  return {
    headers: order,
    payments,
    coverage: {
      read: result.payments.length,
      used,
      documentsFetched: toFetch.length,
      truncated: result.truncated || skippedByCap > 0,
    },
    excluded,
    notes,
  };
}

/** A scanned document's share in a report: all of it, or the part a payment settled. */
export interface Contribution {
  readonly document: ScannedDocument;
  /**
   * Paid share `paid` ÷ `gross` (`gross` positive; `paid` negative for a reversal or refund that
   * moved money against the document's usual direction); `undefined` for the whole document.
   */
  readonly share?: { readonly paid: Decimal; readonly gross: Decimal } | undefined;
}

/**
 * One contribution per scanned document, or one per payment for documents in `payments`: the
 * share is the payment's `signedForDocument` over the absolute gross (capped at the whole
 * document), so a bounced debit or a refund reduces what the document's other payments added.
 * Documents with payments but a gross of zero contribute nothing.
 */
export function contributionsOf(
  documents: readonly ScannedDocument[],
  payments: ReadonlyMap<string, readonly DocumentPayment[]>,
): Contribution[] {
  const contributions: Contribution[] = [];
  for (const document of documents) {
    const paid = payments.get(headerKey(document.header));
    if (paid === undefined) {
      contributions.push({ document });
      continue;
    }
    const gross = document.header.gross;
    if (gross === undefined || isZero(gross)) continue;
    const whole = compare(gross, 0) < 0 ? negate(gross) : gross;
    for (const payment of paid) {
      const signed = decimal(payment.signedForDocument.amount);
      const negative = compare(signed, 0) < 0;
      const amount = negative ? negate(signed) : signed;
      const capped = compare(amount, whole) > 0 ? whole : amount;
      contributions.push({
        document,
        share: { paid: negative ? negate(capped) : capped, gross: whole },
      });
    }
  }
  return contributions;
}

/** A group's amounts for a contribution: as they are, or the paid share (rounded to cents). */
export function contributedAmounts(
  group: PositionGroup,
  share: Contribution["share"],
): { readonly net: Decimal; readonly tax: Decimal } {
  if (share === undefined) return { net: group.net, tax: group.tax };
  return {
    net: ratioOf(group.net, share.paid, share.gross),
    tax: ratioOf(group.tax, share.paid, share.gross),
  };
}

// ---------------------------------------------------------------------------------------------
// Contacts (ZM)
// ---------------------------------------------------------------------------------------------

/**
 * The USt-IdNr. of each contact (`GET /Contact/{id}`, one request per contact), for documents
 * whose list row did not embed the contact. Contacts that cannot be read count as without VAT id
 * (a cancellation is still rethrown).
 */
export async function loadContactVatIds(
  client: SevdeskClient,
  contactIds: readonly number[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<number, string | undefined>> {
  const ids = [...new Set(contactIds)].sort((a, b) => a - b);
  const values = await mapLimited(
    ids,
    POSITION_CONCURRENCY,
    async (id) => {
      try {
        const payload = await client.request({
          method: "GET",
          path: sevdeskPath("Contact", id),
          ...(signal === undefined ? {} : { signal }),
        });
        const contact = toContactDto(parseContactRecord(expectSingle(payload, `contact ${id}`)));
        return normalizeVatId(contact.vatNumber);
      } catch (error) {
        if (error instanceof SevdeskError && error.kind !== "aborted") return undefined;
        throw error;
      }
    },
    signal,
  );
  return new Map(ids.map((id, index) => [id, values[index]]));
}

// ---------------------------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------------------------

/**
 * Maps `items` with at most `limit` calls in flight, keeping the input order in the result. Stops
 * starting new calls after the first failure (which is rethrown) or a cancellation.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      throwIfAborted(signal);
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  const settled = await Promise.allSettled(workers);
  const rejection = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejection !== undefined) throw rejection.reason;
  return results;
}
