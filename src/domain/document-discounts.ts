/**
 * Document discounts (Rabatt auf den Gesamtbetrag) of invoices, credit notes and orders
 * (spec/deviations.md D-116): reading the stored rows and the DTO the get and draft tools return.
 *
 * sevDesk keeps a document discount in rows of their own (`Discounts`), not on the document. The
 * raw `GET /<kind>/{id}` carries only the sums (`sumDiscounts` and `sumDiscountNet`, net, and
 * `sumDiscountGross`, negative for a deduction); its `discount` and `discountTime` are the cash
 * discount (Skonto), something else. The rows are read with
 * `GET /Invoice|CreditNote|Order/{id}/getDiscounts` (recorded 2026-11-16 on all three; only the
 * order one is in the spec): `discount` "1" (a discount; "0" is a surcharge per `Model_Discount`,
 * not recorded), `percentage` "1" (percent) or "0" (a fixed amount), `value`, `isNet` ("1" net,
 * "0" gross) and `object`, the document, all as strings. For a document without discounts the
 * answer is `{objects: [], total: null}`.
 *
 * A document can hold several rows (a second `discountSave` without a delete adds one), but then
 * sevDesk's sums do not count all of them: in the check of 2026-11-17 (a fixed 5.00, then 3 %) only
 * the newer row was in the totals. Every place that shows the rows says so when there are several
 * ({@link severalDiscountsWarning}).
 */
import { z } from "zod";

import { SevdeskError } from "../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../sevdesk/paths.js";
import { parseUpstream, zBool01, zId, zOptionalDecimal, zRef, zText } from "../sevdesk/schema.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { cleanText, compact, moneySchema, splitTotals } from "./common.js";
import { TEXT_MAX } from "./document-positions.js";
import type { Money } from "./money.js";

/** The document kinds that carry discounts. */
export type DiscountDocumentKind = "invoice" | "creditNote" | "order";

const OBJECT_NAMES: Readonly<Record<DiscountDocumentKind, "Invoice" | "CreditNote" | "Order">> = {
  invoice: "Invoice",
  creditNote: "CreditNote",
  order: "Order",
};

/** Rows read in one request; a document with this many discounts is refused (see below). */
const PAGE_SIZE = 1000;

/** One row of `getDiscounts`: the fields this server reads (others are ignored). */
const discountRowSchema = z.object({
  id: zId,
  object: zRef().nullish(),
  text: zText,
  discount: zBool01.optional(),
  percentage: zBool01.optional(),
  value: zOptionalDecimal,
  isNet: zBool01.optional(),
});

/** A stored document discount. `text` is raw sevDesk text: untrusted and not cleaned. */
export interface DiscountRow {
  readonly id: number;
  readonly text: string | undefined;
  /** A surcharge (Aufschlag, `discount` "0") instead of a discount. */
  readonly surcharge: boolean;
  /** A percentage of the total; otherwise a fixed amount. */
  readonly percentage: boolean;
  /** Exact decimal as stored, e.g. "10". */
  readonly value: string;
  /** Net (`true`) or gross (`false`); `undefined` when sevDesk sent none. */
  readonly isNet: boolean | undefined;
}

/** The discounts of one document. */
export interface StoredDiscounts {
  /** The rows exactly as sevDesk sent them: what an approval binds. */
  readonly raw: readonly unknown[];
  /** The parsed rows, by id. */
  readonly rows: readonly DiscountRow[];
}

function unexpected(message: string): SevdeskError {
  return new SevdeskError({ kind: "unexpected_response", message });
}

/**
 * Reads the discounts of one document (`GET /<kind>/{id}/getDiscounts`, one page with an explicit
 * limit). Every row must name this document as its `object` and carry a value; anything else, and
 * a page as long as the limit (the rest would be unknown), is an `unexpected_response` error:
 * nothing is shown, approved or replaced on discounts this server could not read completely.
 */
export async function readDocumentDiscounts(
  client: SevdeskClient,
  kind: DiscountDocumentKind,
  documentId: number,
  signal?: AbortSignal,
): Promise<StoredDiscounts> {
  const id = toSevdeskId(documentId);
  const objectName = OBJECT_NAMES[kind];
  const page = await client.list(sevdeskPath(objectName, id, "getDiscounts"), undefined, {
    limit: PAGE_SIZE,
    ...(signal === undefined ? {} : { signal }),
  });
  if (page.items.length >= PAGE_SIZE) {
    throw unexpected(
      `sevDesk listed ${PAGE_SIZE} or more discounts for one document, more than this server ` +
        "reads. Check the document in sevDesk.",
    );
  }
  const rows = page.items.map((raw) => {
    const row = parseUpstream(discountRowSchema, raw, "a document discount");
    if (row.object?.id !== id || row.object.objectName !== objectName || row.value === undefined) {
      throw unexpected(
        "sevDesk listed a document discount that does not belong to the document or has no value.",
      );
    }
    return {
      id: row.id,
      text: row.text,
      surcharge: row.discount === false,
      percentage: row.percentage === true,
      value: row.value,
      isNet: row.isNet,
    };
  });
  return { raw: page.items, rows: rows.sort((a, b) => a.id - b.id) };
}

// ---------------------------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------------------------

const discountItemSchema = z.object({
  id: z.number().int(),
  kind: z
    .enum(["percent", "amount"])
    .describe("percent: value is a percentage of the total; amount: a fixed amount."),
  value: z.string().describe("Exact decimal as stored, e.g. '3' or '50'."),
  basis: z
    .enum(["net", "gross"])
    .optional()
    .describe("Whether it applies to the net or the gross amounts (isNet)."),
  surcharge: z
    .boolean()
    .optional()
    .describe("True for a surcharge (Aufschlag) instead of a discount; left out otherwise."),
  text: z.string().optional().describe("Text printed with it."),
});

/** The document discount of a get or draft tool's output. */
export const documentDiscountSchema = z
  .object({
    items: z.array(discountItemSchema).describe("The stored discount rows, by id."),
    net: moneySchema
      .optional()
      .describe(
        "What the discounts change on the net total, as sevDesk computed it (sumDiscountNet): " +
          "negative for a deduction.",
      ),
    gross: moneySchema
      .optional()
      .describe("The same on the gross total (sumDiscountGross): negative for a deduction."),
    warning: z
      .string()
      .optional()
      .describe(
        "Set when there are several rows: sevDesk's totals may count only one of them, so check " +
          "the total in sevDesk.",
      ),
  })
  .meta({ id: "DocumentDiscount" });

export type DocumentDiscount = z.output<typeof documentDiscountSchema>;

/** The discount sums of a parsed document record (see `salesDocumentFields`). */
export interface DiscountSums {
  readonly sumDiscountNet?: string | undefined;
  readonly sumDiscountGross?: string | undefined;
  readonly sumDiscountNetForeignCurrency?: string | undefined;
  readonly sumDiscountGrossForeignCurrency?: string | undefined;
}

/**
 * The discount sums in the document's own currency, as `splitTotals` picks a document's sums: the
 * plain fields for EUR, the `…ForeignCurrency` ones when sevDesk converted a foreign document.
 */
export function discountTotals(
  sums: DiscountSums,
  currency: string,
): { readonly net?: Money | undefined; readonly gross?: Money | undefined } {
  const { totals } = splitTotals(
    {
      sumNet: sums.sumDiscountNet,
      sumGross: sums.sumDiscountGross,
      sumNetForeignCurrency: sums.sumDiscountNetForeignCurrency,
      sumGrossForeignCurrency: sums.sumDiscountGrossForeignCurrency,
    },
    currency,
  );
  return compact({ net: totals.net, gross: totals.gross });
}

/**
 * A trusted warning for a document with `count` discount rows when there are several: sevDesk's
 * totals then do not count all of them (see the module comment). `undefined` for one or none.
 */
function severalDiscountsWarning(count: number): string | undefined {
  if (count < 2) return undefined;
  return (
    `This document has ${String(count)} discounts on the whole document, and sevDesk's totals ` +
    "may count only one of them (in a check, only the newest), so the total may not be what the " +
    "rows suggest. Check it in sevDesk."
  );
}

/**
 * The DTO of a document's discounts: the rows (text cleaned), the sums sevDesk computed for them
 * in the document's currency, and a warning when there are several. `undefined` when the document
 * has none.
 */
export function documentDiscountDto(
  rows: readonly DiscountRow[],
  sums: DiscountSums,
  currency: string,
): DocumentDiscount | undefined {
  if (rows.length === 0) return undefined;
  return compact({
    items: rows.map((row) =>
      compact({
        id: row.id,
        kind: row.percentage ? ("percent" as const) : ("amount" as const),
        value: row.value,
        basis:
          row.isNet === undefined ? undefined : row.isNet ? ("net" as const) : ("gross" as const),
        surcharge: row.surcharge ? true : undefined,
        text: cleanText(row.text, TEXT_MAX.short),
      }),
    ),
    ...discountTotals(sums, currency),
    warning: severalDiscountsWarning(rows.length),
  });
}
