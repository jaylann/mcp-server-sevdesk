/**
 * Vouchers (Belege): receipts and other bookkeeping documents. Lenient parsing of sevDesk's
 * `Voucher` and `VoucherPos` records, the compact DTOs the voucher tools return, and the read
 * operations behind them.
 *
 * Conventions pinned by `test/regressions/expense-sign.test.ts`:
 * - `creditDebit` **C = credit = expense** (Ausgabe, "you bought something") and **D = debit =
 *   revenue** (Einnahme, "you sold something"). Source: spec tag `Voucher`, attribute table,
 *   `creditDebit`. Other sevDesk integrations got this backwards.
 * - Voucher sums are positive for both kinds; the kind says which way the money flows. A payment
 *   for an expense voucher leaves the bank account, so it is negative there and in `bookAmount`
 *   (see {@link bookingAmountSign}).
 * - For a voucher in a foreign currency, sevDesk keeps the EUR base value in `sumNet`/`sumTax`/
 *   `sumGross` and the document's own amounts in `sum*ForeignCurrency` (community evidence:
 *   numtide/freelancer-toolbox, which shipped the opposite reading as a bug first).
 *
 * Shapes: recorded `GET /Voucher` and `GET /VoucherPos` (emuuu/sevDesk.NET, 2026-02-19, Update
 * 2.0); `document` and `accountDatev` from the spec (`Model_VoucherResponse`,
 * `Model_VoucherPosResponse`). All text from sevDesk is untrusted and goes through
 * `sanitizeUntrusted` (via {@link cleanText}).
 */
import { z } from "zod";

import { expectSingle } from "../sevdesk/envelope.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import {
  parseUpstream,
  zBerlinDate,
  zBool01,
  zId,
  zNullableInt,
  zNumberish,
  zOptionalDecimal,
  zOptionalRef,
  zText,
} from "../sevdesk/schema.js";
import {
  detectGeneration,
  detectPositionGeneration,
  type SystemVersion,
} from "../sevdesk/system-version.js";
import type { QueryValue, SevdeskClient } from "../sevdesk/types.js";
import {
  cleanText,
  compact,
  currencyCode,
  documentDateFilter,
  moneyFromUpstream,
  moneySchema,
  splitTotals,
  statusDto,
  statusDtoSchema,
} from "./common.js";
import { listDocuments } from "./document-positions.js";
import { voucherLink } from "./links.js";
import { compare, DEFAULT_CURRENCY } from "./money.js";
import { type ChildRows, listChildRows, type PageState, type PageWindow } from "./paging.js";
import { taxRuleById } from "./reference-data.js";

const NAME_MAX = 300;
const FIELD_MAX = 200;
const COMMENT_MAX = 1_000;

// ---------------------------------------------------------------------------------------------
// Fixed vocabularies
// ---------------------------------------------------------------------------------------------

export const VOUCHER_KINDS = ["expense", "revenue"] as const;
export type VoucherKind = (typeof VOUCHER_KINDS)[number];

/** Spec tag `Voucher`, attribute `creditDebit`: C = credit (expense), D = debit (revenue). */
const CREDIT_DEBIT_BY_KIND: Readonly<Record<VoucherKind, "C" | "D">> = {
  expense: "C",
  revenue: "D",
};

export const VOUCHER_STATUS_KEYS = [
  "draft",
  "open",
  "transferred",
  "partially_paid",
  "paid",
] as const;
type VoucherStatusKey = (typeof VOUCHER_STATUS_KEYS)[number];

/** Spec tag `Voucher` → "Types and status of vouchers" (see also spec/deviations.md D-007). */
const VOUCHER_STATUS_CODES: Readonly<Record<VoucherStatusKey, number>> = {
  draft: 50,
  open: 100,
  transferred: 150,
  partially_paid: 750,
  paid: 1000,
};

export const VOUCHER_TYPE_KEYS = ["normal", "recurring"] as const;
type VoucherTypeKey = (typeof VOUCHER_TYPE_KEYS)[number];

/** Spec tag `Voucher`: VOU = normal voucher, RV = recurring voucher. */
const VOUCHER_TYPE_CODES: Readonly<Record<VoucherTypeKey, string>> = {
  normal: "VOU",
  recurring: "RV",
};

/** `creditDebit` value for a kind: expense → `C`, revenue → `D`. */
export function creditDebitForKind(kind: VoucherKind): "C" | "D" {
  return CREDIT_DEBIT_BY_KIND[kind];
}

/** Kind of a voucher from its `creditDebit`: `C` → expense, `D` → revenue, else `undefined`. */
export function voucherKindFromCreditDebit(value: string | undefined): VoucherKind | undefined {
  const code = value?.trim().toUpperCase();
  if (code === "C") return "expense";
  if (code === "D") return "revenue";
  return undefined;
}

/**
 * Sign of a payment for a voucher of this kind as it flows over the check account, which is the
 * sign sevDesk's `PUT /Voucher/{id}/bookAmount` expects: `-1` for expenses (money leaves the
 * account), `1` for revenue. A positive amount on an expense voucher is accepted without error and
 * stored as a negative `paidAmount`, which leaves the voucher partially paid (750) with no pay date
 * (genz-its/sevdesk, verified live). Write tools must apply this sign; read tools use it to state
 * the payment direction.
 */
export function bookingAmountSign(kind: VoucherKind): -1 | 1 {
  return kind === "expense" ? -1 : 1;
}

// ---------------------------------------------------------------------------------------------
// Upstream schemas (lenient)
// ---------------------------------------------------------------------------------------------

/** `Voucher` as returned by `GET /Voucher` and `GET /Voucher/{id}` (fields the DTOs need). */
const voucherRecordSchema = z.object({
  id: zId,
  create: zBerlinDate,
  update: zBerlinDate,
  voucherDate: zBerlinDate,
  supplier: zOptionalRef,
  supplierName: zText,
  supplierNameAtSave: zText,
  description: zText,
  document: zOptionalRef,
  payDate: zBerlinDate,
  status: zNullableInt,
  currency: zText,
  sumNet: zOptionalDecimal,
  sumTax: zOptionalDecimal,
  sumGross: zOptionalDecimal,
  sumNetForeignCurrency: zOptionalDecimal,
  sumTaxForeignCurrency: zOptionalDecimal,
  sumGrossForeignCurrency: zOptionalDecimal,
  paidAmount: zOptionalDecimal,
  taxType: zText,
  taxRule: zOptionalRef,
  creditDebit: zText,
  voucherType: zText,
  recurringInterval: zText,
  recurringNextVoucher: zBerlinDate,
  enshrined: zText,
  paymentDeadline: zBerlinDate,
  deliveryDate: zBerlinDate,
  deliveryDateUntil: zBerlinDate,
});

type VoucherRecord = z.output<typeof voucherRecordSchema>;

/** `VoucherPos` as returned by `GET /VoucherPos` (fields the DTO needs). */
const positionRecordSchema = z.object({
  id: zId,
  voucher: zOptionalRef,
  accountDatev: zOptionalRef,
  accountingType: zOptionalRef,
  taxRate: zNumberish.optional(),
  isAsset: zBool01.optional(),
  sumNet: zOptionalDecimal,
  sumTax: zOptionalDecimal,
  sumGross: zOptionalDecimal,
  sumNetForeignCurrency: zOptionalDecimal,
  sumTaxForeignCurrency: zOptionalDecimal,
  sumGrossForeignCurrency: zOptionalDecimal,
  comment: zText,
});

type PositionRecord = z.output<typeof positionRecordSchema>;

// ---------------------------------------------------------------------------------------------
// DTOs (also the tools' output schemas)
// ---------------------------------------------------------------------------------------------

const baseAmountsSchema = z
  .object({
    net: moneySchema.optional(),
    tax: moneySchema.optional(),
    gross: moneySchema.optional(),
  })
  .describe(
    "Foreign-currency vouchers only: sevDesk's amounts in EUR (Buchungswährung). net/tax/gross " +
      "above are in the voucher's own currency.",
  );

/** Compact voucher, one row of `sevdesk_vouchers_list`. */
export const voucherDtoSchema = z.object({
  id: z.number().int(),
  number: z
    .string()
    .optional()
    .describe("Belegnummer or description as entered (sevDesk's description field)."),
  supplier: z
    .object({
      id: z.number().int().optional().describe("Contact id, for sevdesk_contact_get."),
      name: z.string().optional(),
    })
    .optional()
    .describe("Supplier (Lieferant) of an expense, customer of a revenue voucher."),
  date: z.string().optional().describe("Belegdatum, YYYY-MM-DD."),
  paymentDeadline: z.string().optional().describe("Fälligkeit, YYYY-MM-DD."),
  payDate: z.string().optional().describe("Date it was paid, YYYY-MM-DD."),
  status: statusDtoSchema.optional(),
  kind: z
    .enum(VOUCHER_KINDS)
    .optional()
    .describe(
      "expense (Ausgabe, creditDebit C: payments leave the bank account, negative amounts) or " +
        "revenue (Einnahme, creditDebit D: payments come in).",
    ),
  type: z.enum(VOUCHER_TYPE_KEYS).optional().describe("normal (VOU) or recurring (RV)."),
  currency: z.string().describe("Currency of the voucher (ISO 4217)."),
  net: moneySchema.optional(),
  tax: moneySchema.optional(),
  gross: moneySchema.optional().describe("Bruttobetrag; positive for expenses and revenue alike."),
  base: baseAmountsSchema.optional(),
  paidAmount: moneySchema
    .optional()
    .describe("Paid so far; for foreign-currency vouchers taken as EUR (not verified)."),
  hasDocument: z
    .boolean()
    .optional()
    .describe("Whether a receipt file is attached, when sevDesk reports it."),
  generation: z
    .enum(["1.0", "2.0"])
    .optional()
    .describe("Bookkeeping generation: 2.0 uses tax rules, 1.0 the legacy tax types."),
  warnings: z.array(z.string()).optional().describe("Problems found in the data, if any."),
  link: z.string().optional().describe("Opens the voucher in the sevDesk web app."),
});

export type VoucherDto = z.output<typeof voucherDtoSchema>;

/** One voucher with the details `sevdesk_voucher_get` adds. */
export const voucherDetailDtoSchema = voucherDtoSchema.extend({
  taxRule: z
    .object({
      id: z.number().int(),
      name: z.string().optional(),
      nameEn: z.string().optional(),
    })
    .optional()
    .describe("Update 2.0 tax rule (Steuerregel); details via sevdesk_reference_lookup."),
  taxType: z.string().optional().describe("Update 1.0 tax type (default, eu, noteu, custom, ss)."),
  deliveryDate: z.string().optional().describe("Leistungsdatum, YYYY-MM-DD."),
  deliveryDateUntil: z.string().optional().describe("End of the service period, YYYY-MM-DD."),
  enshrined: z.boolean().describe("Festgeschrieben: locked, can no longer be changed."),
  paymentDirection: z
    .enum(["out", "in"])
    .optional()
    .describe(
      "How a payment for it moves on the bank account: out (negative transaction and negative " +
        "booking amount) for expenses, in for revenue.",
    ),
  recurring: z
    .object({
      interval: z.string().describe("ISO 8601 interval as sevDesk stores it, e.g. P0Y1M."),
      every: z.string().optional().describe("Readable interval, e.g. 'every 1 month'."),
      nextDate: z.string().optional().describe("Next voucher date, YYYY-MM-DD."),
    })
    .optional()
    .describe("Recurring vouchers (RV) only."),
  createdAt: z.string().optional().describe("YYYY-MM-DD, Europe/Berlin."),
  updatedAt: z.string().optional().describe("YYYY-MM-DD, Europe/Berlin."),
});

type VoucherDetailDto = z.output<typeof voucherDetailDtoSchema>;

/** One voucher position (Belegposition). */
export const voucherPositionDtoSchema = z.object({
  id: z.number().int(),
  comment: z.string().optional().describe("Position text as entered."),
  taxRate: z.number().optional().describe("Tax rate in percent, e.g. 19."),
  net: moneySchema.optional(),
  tax: moneySchema.optional(),
  gross: moneySchema.optional(),
  base: baseAmountsSchema.optional(),
  generation: z.enum(["1.0", "2.0"]).optional(),
  accountDatev: z
    .object({ id: z.number().int() })
    .optional()
    .describe("Update 2.0 booking account (Buchungskonto, AccountDatev id)."),
  accountingType: z
    .object({ id: z.number().int() })
    .optional()
    .describe("Update 1.0 booking account (AccountingType id)."),
  isAsset: z.boolean().optional().describe("Anlagegut (depreciable asset)."),
});

type VoucherPositionDto = z.output<typeof voucherPositionDtoSchema>;

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

function parseVoucherRecord(raw: unknown): VoucherRecord {
  return parseUpstream(voucherRecordSchema, raw, "a voucher");
}

function parsePositionRecord(raw: unknown): PositionRecord {
  return parseUpstream(positionRecordSchema, raw, "voucher positions");
}

function voucherTypeOf(value: string | undefined): VoucherTypeKey | undefined {
  const code = value?.trim().toUpperCase();
  return VOUCHER_TYPE_KEYS.find((key) => VOUCHER_TYPE_CODES[key] === code);
}

const NEGATIVE_PAID_WARNING =
  "paidAmount is negative: a payment was probably booked with the wrong sign (booking amounts " +
  "follow the money flow: negative for expenses, positive for revenue). sevDesk then keeps the " +
  "voucher partially paid.";

/** Maps a parsed voucher to the compact list DTO; `raw` is the upstream record it came from. */
function toVoucherDto(record: VoucherRecord, raw: unknown): VoucherDto {
  const currency = currencyCode(record.currency);
  // The foreign-currency rule (EUR base in sumNet…, document amounts in sum…ForeignCurrency).
  const { totals, eur } = splitTotals(record, currency);
  const paidCurrency = eur === undefined ? currency : DEFAULT_CURRENCY;
  const paidAmount = moneyFromUpstream(record.paidAmount, paidCurrency);
  const supplierName = cleanText(record.supplierName ?? record.supplierNameAtSave, NAME_MAX);
  const supplier =
    record.supplier === undefined && supplierName === undefined
      ? undefined
      : compact({ id: record.supplier?.id, name: supplierName });
  const warnings =
    paidAmount !== undefined && compare(paidAmount.amount, 0) < 0
      ? [NEGATIVE_PAID_WARNING]
      : undefined;

  return compact({
    id: record.id,
    number: cleanText(record.description, FIELD_MAX),
    supplier,
    date: record.voucherDate,
    paymentDeadline: record.paymentDeadline,
    payDate: record.payDate,
    status: record.status === undefined ? undefined : statusDto("voucher", record.status),
    kind: voucherKindFromCreditDebit(record.creditDebit),
    type: voucherTypeOf(record.voucherType),
    currency,
    net: totals.net,
    tax: totals.tax,
    gross: totals.gross,
    base: eur,
    paidAmount,
    // Only when the record carries the key: the recorded list response has no `document` at all.
    hasDocument: hasKey(raw, "document") ? record.document !== undefined : undefined,
    generation: detectGeneration(record),
    warnings,
    link: voucherLink(record.id),
  });
}

function toVoucherDetailDto(record: VoucherRecord, raw: unknown): VoucherDetailDto {
  const base = toVoucherDto(record, raw);
  const rule = record.taxRule === undefined ? undefined : taxRuleById(record.taxRule.id);
  const interval = cleanText(record.recurringInterval, 50);
  return compact({
    ...base,
    taxRule:
      record.taxRule === undefined
        ? undefined
        : rule === undefined
          ? { id: record.taxRule.id }
          : { id: rule.id, name: rule.nameDe, nameEn: rule.nameEn },
    taxType: record.taxRule === undefined ? cleanText(record.taxType, 50) : undefined,
    deliveryDate: record.deliveryDate,
    deliveryDateUntil: record.deliveryDateUntil,
    enshrined: record.enshrined !== undefined,
    paymentDirection:
      base.kind === undefined ? undefined : bookingAmountSign(base.kind) < 0 ? "out" : "in",
    recurring:
      interval === undefined
        ? undefined
        : compact({
            interval,
            every: describeInterval(interval),
            nextDate: record.recurringNextVoucher,
          }),
    createdAt: record.create,
    updatedAt: record.update,
  } satisfies VoucherDetailDto);
}

function toPositionDto(position: PositionRecord, currency: string): VoucherPositionDto {
  const { totals, eur } = splitTotals(position, currency);
  const generation: SystemVersion | undefined = detectPositionGeneration(position);
  return compact({
    id: position.id,
    comment: cleanText(position.comment, COMMENT_MAX),
    taxRate: position.taxRate,
    net: totals.net,
    tax: totals.tax,
    gross: totals.gross,
    base: eur,
    generation,
    accountDatev:
      generation === "2.0" && position.accountDatev !== undefined
        ? { id: position.accountDatev.id }
        : undefined,
    accountingType:
      generation === "1.0" && position.accountingType !== undefined
        ? { id: position.accountingType.id }
        : undefined,
    isAsset: position.isAsset,
  });
}

/**
 * Readable form of sevDesk's ISO 8601 interval (`P0Y1M0W` → "every 1 month"). sevDesk stores
 * several spellings of the same interval (spec/deviations.md D-007), so the value is parsed, not
 * matched against a list. Returns `undefined` for anything else.
 */
export function describeInterval(interval: string): string | undefined {
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(interval);
  if (match === null) return undefined;
  const units = ["year", "month", "week", "day"] as const;
  const parts = units.flatMap((unit, index) => {
    const count = Number(match[index + 1] ?? "0");
    return count > 0 ? [`${count} ${unit}${count === 1 ? "" : "s"}`] : [];
  });
  return parts.length === 0 ? undefined : `every ${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

export interface VoucherListParams {
  readonly status?: VoucherStatusKey | undefined;
  readonly kind?: VoucherKind | undefined;
  readonly supplierId?: number | undefined;
  /** sevDesk's `supplierName` filter ("supplier having a name like"). */
  readonly supplierName?: string | undefined;
  /** sevDesk's `descriptionLike` filter (voucher number / description contains). */
  readonly description?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly type?: VoucherTypeKey | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface VoucherListResult {
  readonly items: readonly VoucherDto[];
  /** `received` counts sevDesk rows read (scanned, with a local filter), before re-checks. */
  readonly window: PageWindow;
  readonly state: PageState;
  /** True when the type filter was applied here: `window` then describes the rows scanned. */
  readonly filteredLocally?: boolean;
}

/**
 * Lists vouchers (`GET /Voucher`) with sevDesk's documented voucher filters (spec tag `Voucher` →
 * "How to filter for certain vouchers").
 *
 * The type is also checked here on every row, because sevDesk ignores filters it does not
 * understand (spec/deviations.md D-035): with a type, the list scans from `offset` like the
 * sales-document lists (see `listDocuments`), `total` is left out and `filteredLocally` is set.
 * The date range goes out as Unix seconds (`startDate`/`endDate`, starting one second before the
 * first day) and every voucher date is checked against it again, so the first day counts under
 * either reading of the spec (see `documentDateFilter`); that re-check only drops rows and keeps
 * sevDesk's paging.
 */
export async function listVouchers(
  client: SevdeskClient,
  params: VoucherListParams,
  signal?: AbortSignal,
): Promise<VoucherListResult> {
  const dates = documentDateFilter(params);
  const { type } = params;
  const query: Record<string, QueryValue> = { ...dates.query };
  if (params.status !== undefined) query["status"] = VOUCHER_STATUS_CODES[params.status];
  if (params.kind !== undefined) query["creditDebit"] = creditDebitForKind(params.kind);
  if (params.supplierId !== undefined) {
    query["contact[id]"] = toSevdeskId(params.supplierId);
    query["contact[objectName]"] = "Contact";
  }
  if (params.supplierName !== undefined) query["supplierName"] = params.supplierName;
  if (params.description !== undefined) query["descriptionLike"] = params.description;
  if (type !== undefined) query["voucherType"] = VOUCHER_TYPE_CODES[type];

  const result = await listDocuments({
    client,
    path: "/Voucher",
    query,
    limit: params.limit,
    offset: params.offset,
    map: (raw) => toVoucherDto(parseVoucherRecord(raw), raw),
    keep: type === undefined ? undefined : (item) => item.type === type,
    recheck: (item) => dates.contains(item.date),
    signal,
  });
  return {
    items: result.items,
    window: { offset: params.offset, received: result.received, total: result.total },
    state: { hasMore: result.hasMore, nextOffset: result.nextOffset },
    ...(result.filteredLocally ? { filteredLocally: true } : {}),
  };
}

export interface VoucherDetails {
  readonly voucher: VoucherDetailDto;
  readonly positions: readonly VoucherPositionDto[];
  /** False when sevDesk had more position rows than could be read; `positions` is then partial. */
  readonly positionsComplete: boolean;
}

/**
 * One voucher (`GET /Voucher/{id}`) with its positions (`GET /VoucherPos` filtered by
 * `voucher[id]`, documented in the spec). Each position's generation is detected on its own, so a
 * 2.0 voucher with legacy 1.0 positions (as in the recorded data) renders both correctly. A
 * missing voucher surfaces as the client's `not_found` error.
 */
export async function getVoucherDetails(
  client: SevdeskClient,
  voucherId: number,
  signal?: AbortSignal,
): Promise<VoucherDetails> {
  const id = toSevdeskId(voucherId);
  const withSignal = signal === undefined ? {} : { signal };
  const payload = await client.request({
    method: "GET",
    path: sevdeskPath("Voucher", id),
    ...withSignal,
  });
  const raw = expectSingle(payload, `voucher ${id}`);
  const record = parseVoucherRecord(raw);
  const voucher = toVoucherDetailDto(record, raw);
  const positions = await listPositions(client, id, withSignal.signal);
  return {
    voucher,
    positions: positions.rows.map((row) => toPositionDto(row, voucher.currency)),
    positionsComplete: positions.complete,
  };
}

/**
 * Positions of one voucher. Rows are also checked against `voucher.id` here, so an ignored filter
 * can never mix in another voucher's positions; see {@link listChildRows} for paging and the cap.
 */
function listPositions(
  client: SevdeskClient,
  voucherId: number,
  signal: AbortSignal | undefined,
): Promise<ChildRows<PositionRecord>> {
  return listChildRows(
    client,
    "/VoucherPos",
    { "voucher[id]": voucherId, "voucher[objectName]": "Voucher" },
    { parse: parsePositionRecord, belongs: (row) => row.voucher?.id === voucherId },
    signal,
  );
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function hasKey(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key);
}
