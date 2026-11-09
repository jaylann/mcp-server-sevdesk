/**
 * Parts (Artikel): lenient parsing of sevDesk's `Part` records, the compact DTOs the part tools
 * return, and the read operations behind them.
 *
 * Shape: recorded `GET /Part` (emuuu/sevDesk.NET, 2026-02-19): numbers arrive as strings
 * (`stock: "100"`, `taxRate: "19"`), `stockEnabled` as `"0"`/`"1"`. In that recording `price`
 * equals `priceGross` although the spec calls `price` the net price, so `price` is not used:
 * net and gross come from `priceNet` and `priceGross` only. Parts carry no currency; prices are in
 * the account currency, EUR. Text is untrusted and goes through `sanitizeUntrusted` (via
 * {@link cleanText}).
 */
import { z } from "zod";

import { expectSingle } from "../sevdesk/envelope.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import {
  parseUpstream,
  zBerlinDate,
  zBool01,
  zDecimalString,
  zId,
  zNullableInt,
  zOptionalDecimal,
  zOptionalRef,
  zText,
} from "../sevdesk/schema.js";
import type { QueryValue, SevdeskClient } from "../sevdesk/types.js";
import { cleanText, compact, moneyFromUpstream, moneySchema } from "./common.js";
import { DEFAULT_CURRENCY } from "./money.js";
import { type PageState, type PageWindow, readPage } from "./paging.js";

const NAME_MAX = 300;
const FIELD_MAX = 200;
const TEXT_MAX = 2_000;

/** Spec `Model_Part.status`: 50 inactive, 100 active. */
const ACTIVE_STATUS = 100;
const INACTIVE_STATUS = 50;

// ---------------------------------------------------------------------------------------------
// Upstream schema (lenient)
// ---------------------------------------------------------------------------------------------

/** `Part` (spec `Model_Part`, recorded `GET /Part`). */
const partRecordSchema = z.object({
  id: zId,
  create: zBerlinDate,
  update: zBerlinDate,
  name: zText,
  partNumber: zText,
  text: zText,
  category: zOptionalRef,
  unity: zOptionalRef,
  stock: zOptionalDecimal,
  stockEnabled: zBool01.optional(),
  priceNet: zDecimalString.optional(),
  priceGross: zDecimalString.optional(),
  pricePurchase: zDecimalString.optional(),
  taxRate: zOptionalDecimal,
  status: zNullableInt,
  internalComment: zText,
});

type PartRecord = z.output<typeof partRecordSchema>;

// ---------------------------------------------------------------------------------------------
// DTOs (also the tools' output schemas)
// ---------------------------------------------------------------------------------------------

/** Compact part, one row of `sevdesk_parts_list`. */
export const partDtoSchema = z.object({
  id: z.number().int(),
  partNumber: z.string().optional().describe("Artikelnummer."),
  name: z.string(),
  unitId: z
    .number()
    .int()
    .optional()
    .describe("Unit (Einheit) id; names via sevdesk_reference_lookup kind=units (1 = Stk)."),
  categoryId: z.number().int().optional().describe("Part category id (Kategorie)."),
  priceNet: moneySchema.optional().describe("Net sales price (Verkaufspreis netto)."),
  priceGross: moneySchema.optional().describe("Gross sales price (Verkaufspreis brutto)."),
  pricePurchase: moneySchema.optional().describe("Purchase price (Einkaufspreis)."),
  taxRate: z.string().optional().describe("Tax rate in percent, e.g. '19'."),
  stock: z.string().optional().describe("Stock (Bestand) stored on the part, e.g. '7.5'."),
  stockEnabled: z.boolean().describe("Whether sevDesk tracks stock (Lagerbestand) for it."),
  active: z.boolean().optional().describe("False for inactive parts (status 50)."),
});

type PartDto = z.output<typeof partDtoSchema>;

/** One part with the details `sevdesk_part_get` adds. */
export const partDetailDtoSchema = partDtoSchema.extend({
  description: z.string().optional().describe("Part text (Beschreibung) used on documents."),
  internalComment: z.string().optional().describe("Internal note, not printed."),
  currentStock: z
    .string()
    .optional()
    .describe("Current stock from sevDesk's stock endpoint; only when stock tracking is on."),
  createdAt: z.string().optional().describe("YYYY-MM-DD, Europe/Berlin."),
  updatedAt: z.string().optional().describe("YYYY-MM-DD, Europe/Berlin."),
});

export type PartDetailDto = z.output<typeof partDetailDtoSchema>;

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

function parsePartRecord(raw: unknown): PartRecord {
  return parseUpstream(partRecordSchema, raw, "a part");
}

function toPartDto(record: PartRecord): PartDto {
  return compact({
    id: record.id,
    partNumber: cleanText(record.partNumber, FIELD_MAX),
    name: cleanText(record.name, NAME_MAX) ?? `(unnamed part ${record.id})`,
    unitId: record.unity?.id,
    categoryId: record.category?.id,
    priceNet: moneyFromUpstream(record.priceNet, DEFAULT_CURRENCY),
    priceGross: moneyFromUpstream(record.priceGross, DEFAULT_CURRENCY),
    pricePurchase: moneyFromUpstream(record.pricePurchase, DEFAULT_CURRENCY),
    taxRate: record.taxRate,
    stock: record.stock,
    stockEnabled: record.stockEnabled ?? false,
    active:
      record.status === ACTIVE_STATUS
        ? true
        : record.status === INACTIVE_STATUS
          ? false
          : undefined,
  });
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

export interface PartListParams {
  readonly partNumber?: string | undefined;
  readonly name?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface PartListResult {
  readonly items: readonly PartDto[];
  readonly window: PageWindow;
  readonly state: PageState;
}

/** Lists parts (`GET /Part`) with sevDesk's documented `partNumber` and `name` filters. */
export async function listParts(
  client: SevdeskClient,
  params: PartListParams,
  signal?: AbortSignal,
): Promise<PartListResult> {
  const query: Record<string, QueryValue> = {};
  if (params.partNumber !== undefined) query["partNumber"] = params.partNumber;
  if (params.name !== undefined) query["name"] = params.name;
  return readPage(client, "/Part", query, params, (raw) => toPartDto(parsePartRecord(raw)), signal);
}

/**
 * One part (`GET /Part/{id}`). When stock tracking is on, also the current stock from
 * `GET /Part/{id}/getStock` (spec: "Returns the current stock amount", a plain read; genz-its
 * wraps it as one). A missing part surfaces as the client's `not_found` error.
 */
export async function getPartDetails(
  client: SevdeskClient,
  partId: number,
  signal?: AbortSignal,
): Promise<PartDetailDto> {
  const id = toSevdeskId(partId);
  const withSignal = signal === undefined ? {} : { signal };
  const payload = await client.request({
    method: "GET",
    path: sevdeskPath("Part", id),
    ...withSignal,
  });
  const record = parsePartRecord(expectSingle(payload, `part ${id}`));

  let currentStock: string | undefined;
  if (record.stockEnabled === true) {
    const stock = await client.request({
      method: "GET",
      path: sevdeskPath("Part", id, "getStock"),
      ...withSignal,
    });
    currentStock = parseUpstream(zDecimalString, stock, "the stock of a part");
  }

  return compact({
    ...toPartDto(record),
    description: cleanText(record.text, TEXT_MAX),
    internalComment: cleanText(record.internalComment, TEXT_MAX),
    currentStock,
    createdAt: record.create,
    updatedAt: record.update,
  });
}
