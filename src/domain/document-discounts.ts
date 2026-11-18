/**
 * Document discounts (Rabatt auf den Gesamtbetrag) of invoices, credit notes and orders
 * (spec/deviations.md D-116): reading the stored rows and the DTO the get and draft tools return.
 *
 * sevDesk keeps a document discount in rows of their own (`Discounts`), not on the document. The
 * raw `GET /<kind>/{id}` carries only the sums (`sumDiscounts` and `sumDiscountNet`, net, and
 * `sumDiscountGross`, negative for a deduction); its `discount` and `discountTime` are the cash
 * discount (Skonto), something else. The rows are read with
 * `GET /Invoice|CreditNote|Order/{id}/getDiscounts` (recorded 2026-11-16 on all three; only the
 * order one is in the spec): `discount` "1" (a discount) or "0" (a surcharge, which adds: recorded
 * 2026-11-18, probe `write-discount-mixed-tax-uneven`), `percentage` "1" (percent) or "0" (a fixed
 * amount), `value`, `isNet` and `object`, the document, all as strings. For a document without
 * discounts the answer is `{objects: [], total: null}`.
 *
 * `isNet` is stored as sent, "1" when the save leaves it out (recorded 2026-11-18, probes
 * `write-discount-net-gross`, `write-discount-mixed-tax-uneven`), but it does not decide what
 * sevDesk deducts: on a document with gross prices (`showNet` false) a fixed amount comes off the
 * gross total with `isNet` "1" and "0" alike, and on one with net prices it comes off the net total
 * with `isNet` "1" and "0" alike. A percentage takes the same share of net, tax and gross on
 * either. So the basis shown for a fixed amount follows the document's price mode
 * ({@link appliedDiscount}), and `isNet` only where that is not known.
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
import { DEFAULT_CURRENCY, type Money, money } from "./money.js";
import { numberText, type Phrase, phrase, type PreviewLanguage } from "./preview-text.js";

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
 * limit). Every row must name this document as its `object` and carry a value and both its
 * `discount` and `percentage` flags (readable as "0"/"1"); anything else, and
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
    // Recorded rows always carry both flags (D-116). Without one, whether the row deducts or
    // adds, and whether its value is a percentage or an amount, would be a guess.
    if (row.discount === undefined || row.percentage === undefined) {
      throw unexpected(
        "sevDesk listed a document discount without saying whether it is a discount or a " +
          "surcharge and whether its value is a percentage or an amount. Check the document in " +
          "sevDesk.",
      );
    }
    return {
      id: row.id,
      text: row.text,
      surcharge: !row.discount,
      percentage: row.percentage,
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
    .describe(
      "net or gross: the total a fixed amount comes off (on gross prices always the gross " +
        "total); a percentage takes the same share of both.",
    ),
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
 * The trusted sentence for a document with `count` discount rows when there are several:
 * sevDesk's totals then do not count all of them (see the module comment). `undefined` for one or
 * none. The DTO's `warning` is its English half; approvals show both halves.
 */
export function severalDiscountsWarning(count: number): Phrase | undefined {
  if (count < 2) return undefined;
  return phrase(
    `This document has ${String(count)} discounts on the whole document, and sevDesk's totals ` +
      "may count only one of them (in a check, only the newest), so the total may not be what " +
      "the listed discounts suggest. Check the total in sevDesk.",
    `Das Dokument hat ${String(count)} Rabatte auf den Gesamtbetrag, und sevDesk rechnet in den ` +
      "Summen womöglich nur einen davon ein (in einer Prüfung nur den neuesten); die Summe ist " +
      "dann nicht, was die aufgeführten Rabatte erwarten lassen. Prüfe die Summe in sevDesk.",
  );
}

// ---------------------------------------------------------------------------------------------
// Preview text
// ---------------------------------------------------------------------------------------------

/**
 * What {@link discountRowText} reads of a discount: a stored row ({@link DiscountRow} fits), a DTO
 * item ({@link discountAmountOfItem}) or a new discount a draft tool writes.
 */
export interface DiscountAmount {
  readonly surcharge: boolean;
  readonly percentage: boolean;
  /** Exact decimal, e.g. "10" or "50.5". */
  readonly value: string;
  /** Net (`true`) or gross (`false`); `undefined` reads as net. */
  readonly isNet: boolean | undefined;
}

/** A document's price mode (`showNet`), `undefined` when sevDesk sent none. */
type PriceModeOfDocument = "net" | "gross" | undefined;

/**
 * A stored discount with the basis sevDesk applies it on (see the module comment): a fixed amount
 * comes off the total of the document's price mode whatever its `isNet` (gross on gross prices,
 * net on net prices); a percentage, and a fixed amount on a document of unknown price mode, keep
 * the stored `isNet`.
 */
export function appliedDiscount<T extends DiscountAmount>(
  row: T,
  priceMode: PriceModeOfDocument,
): T {
  if (row.percentage || priceMode === undefined) return row;
  return { ...row, isNet: priceMode === "net" };
}

/** The {@link DiscountAmount} of a DTO item. */
export function discountAmountOfItem(item: DocumentDiscount["items"][number]): DiscountAmount {
  return {
    surcharge: item.surcharge === true,
    percentage: item.kind === "percent",
    value: item.value,
    isNet: item.basis === undefined ? undefined : item.basis === "net",
  };
}

const ROW_WORDS: Readonly<
  Record<
    PreviewLanguage,
    {
      readonly net: string;
      readonly gross: string;
      readonly ofNet: string;
      readonly ofGross: string;
      readonly surcharge: string;
    }
  >
> = {
  en: {
    net: "net",
    gross: "gross",
    ofNet: "of the net total",
    ofGross: "of the gross total",
    surcharge: "surcharge (Aufschlag)",
  },
  de: {
    net: "netto",
    gross: "brutto",
    ofNet: "vom Nettobetrag",
    ofGross: "vom Bruttobetrag",
    surcharge: "Aufschlag",
  },
};

/**
 * One discount on the whole document as every preview and approval shows it: "10 % of the net
 * total", "10.00 EUR net", a surcharge marked as such. A fixed amount is shown exactly, with at
 * least two decimals, in the document's currency: sevDesk reads it in that currency, also on a
 * document in another currency than EUR (D-116, recorded 2026-11-18 for CHF). Pass a stored row
 * through {@link appliedDiscount} first, so a fixed amount on gross prices reads as gross. The
 * text printed with the discount is not part of it: each preview places that untrusted text its
 * own way.
 */
export function discountRowText(
  row: DiscountAmount,
  currency: string,
  lang: PreviewLanguage,
): string {
  const words = ROW_WORDS[lang];
  const gross = row.isNet === false;
  const basis = gross ? words.gross : words.net;
  // `money` renders the exact value with at least two decimals; only its amount is used here.
  const fixed = numberText(money(row.value, DEFAULT_CURRENCY).amount, lang);
  const amount = row.percentage
    ? `${numberText(row.value, lang)} % ${gross ? words.ofGross : words.ofNet}`
    : `${fixed} ${currency} ${basis}`;
  return row.surcharge ? `${words.surcharge}: ${amount}` : amount;
}

/**
 * The DTO of a document's discounts: the rows (text cleaned, the basis as sevDesk applies it on
 * the document's price mode, {@link appliedDiscount}), the sums sevDesk computed for them in the
 * document's currency, and a warning when there are several. `undefined` when the document has
 * none.
 */
export function documentDiscountDto(
  stored: readonly DiscountRow[],
  sums: DiscountSums,
  currency: string,
  priceMode: PriceModeOfDocument,
): DocumentDiscount | undefined {
  if (stored.length === 0) return undefined;
  const rows = stored.map((row) => appliedDiscount(row, priceMode));
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
    warning: severalDiscountsWarning(rows.length)?.en,
  });
}
