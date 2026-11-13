/**
 * Browsing projections of normalized list rows. Full rows remain the default; summaries never
 * re-read upstream fields, so date serialization, currency selection and text cleaning stay
 * identical. List output unions put the full schema first to retain its field order even when
 * a sparse full row also fits the summary shape. Summary schemas reject extra fields so a
 * malformed full row cannot silently fall back to a stripped summary. Contact summaries already
 * satisfy the full contact schema. Unknown status/type keys are omitted, not invented.
 */
import { z } from "zod";

import { transactionDtoSchema } from "./banking.js";
import { compact, moneySchema } from "./common.js";
import type { ContactDto } from "./contacts.js";
import { creditNoteRowSchema } from "./credit-notes.js";
import { invoiceRowSchema, UNPAID_STATUSES } from "./invoices.js";
import { money, subtract } from "./money.js";
import { orderRowSchema } from "./orders.js";
import { partDtoSchema } from "./parts.js";
import { VOUCHER_KINDS, VOUCHER_TYPE_KEYS, voucherDtoSchema } from "./vouchers.js";

export const listDetailInputShape = {
  detail: z
    .enum(["summary", "full"])
    .default("full")
    .describe("Use summary to browse/find; full (default) or the matching get tool for details."),
};

// Summary fields keep the full DTO constraints without repeating its descriptive metadata.
const optionalText = z.string().optional();
const optionalId = z.number().int().optional();
const contact = z.strictObject({ id: z.number().int(), name: optionalText }).optional();
const currency = moneySchema.shape.currency;
const status = optionalText;
const gross = moneySchema.shape.amount.optional().describe("Gross total in currency.");

export const invoiceSummarySchema = z.strictObject({
  id: z.number().int(),
  number: optionalText,
  contact,
  date: optionalText,
  dueDate: optionalText,
  overdue: z.boolean().optional(),
  currency,
  cancelsInvoiceId: optionalId,
  type: optionalText,
  status,
  gross,
  openAmount: moneySchema.shape.amount
    .optional()
    .describe(
      "Open/partially paid invoices only: gross minus paid in currency; absent if amounts or currency are unknown.",
    ),
});

export function invoiceSummary(
  row: z.output<typeof invoiceRowSchema>,
): z.output<typeof invoiceSummarySchema> {
  const total = row.totals.gross;
  const paid = row.paid;
  return compact({
    id: row.id,
    number: row.number,
    type: row.type.key,
    status: row.status.key,
    contact: row.contact,
    date: row.date,
    dueDate: row.dueDate,
    overdue: row.overdue,
    gross: total?.amount,
    currency: row.currency,
    // In particular, do not assume that an absent foreign-currency payment means zero paid.
    openAmount:
      UNPAID_STATUSES.has(row.status.code) &&
      total !== undefined &&
      paid !== undefined &&
      total.currency === paid.currency
        ? money(subtract(total.amount, paid.amount), total.currency).amount
        : undefined,
    cancelsInvoiceId: row.cancelsInvoiceId,
  });
}

export const creditNoteSummarySchema = z.strictObject({
  id: z.number().int(),
  number: optionalText,
  contact,
  date: optionalText,
  currency,
  sourceInvoiceId: optionalId,
  sourceVoucherId: optionalId,
  status,
  gross,
});

export function creditNoteSummary(
  row: z.output<typeof creditNoteRowSchema>,
): z.output<typeof creditNoteSummarySchema> {
  return compact({
    id: row.id,
    number: row.number,
    status: row.status.key,
    contact: row.contact,
    date: row.date,
    gross: row.totals.gross?.amount,
    currency: row.currency,
    sourceInvoiceId: row.sourceInvoiceId,
    sourceVoucherId: row.sourceVoucherId,
  });
}

export const orderSummarySchema = z.strictObject({
  id: z.number().int(),
  number: optionalText,
  contact,
  date: optionalText,
  currency,
  type: optionalText,
  status,
  gross,
});

export function orderSummary(
  row: z.output<typeof orderRowSchema>,
): z.output<typeof orderSummarySchema> {
  return compact({
    id: row.id,
    number: row.number,
    type: row.type.key,
    status: row.status.key,
    contact: row.contact,
    date: row.date,
    gross: row.totals.gross?.amount,
    currency: row.currency,
  });
}

export const voucherSummarySchema = z.strictObject({
  id: z.number().int(),
  number: optionalText,
  supplier: z.strictObject({ id: optionalId, name: optionalText }).optional(),
  date: optionalText,
  paymentDeadline: optionalText,
  kind: z.enum(VOUCHER_KINDS).optional(),
  type: z.enum(VOUCHER_TYPE_KEYS).optional(),
  currency,
  warnings: z.array(z.string()).optional(),
  status,
  gross,
});

export function voucherSummary(
  row: z.output<typeof voucherDtoSchema>,
): z.output<typeof voucherSummarySchema> {
  return compact({
    id: row.id,
    number: row.number,
    status: row.status?.key,
    kind: row.kind,
    type: row.type,
    supplier: row.supplier,
    date: row.date,
    paymentDeadline: row.paymentDeadline,
    gross: row.totals.gross?.amount,
    currency: row.currency,
    warnings: row.warnings,
  });
}

export const transactionSummarySchema = z.strictObject({
  id: z.number().int(),
  account: contact,
  valueDate: optionalText,
  entryDate: optionalText,
  counterparty: optionalText,
  purpose: optionalText,
  status,
  amount: moneySchema.shape.amount,
  currency,
});

export function transactionSummary(
  row: z.output<typeof transactionDtoSchema>,
): z.output<typeof transactionSummarySchema> {
  return compact({
    id: row.id,
    account: row.account,
    valueDate: row.valueDate,
    entryDate: row.entryDate,
    amount: row.amount.amount,
    currency: row.amount.currency,
    status: row.status?.key,
    counterparty: row.counterparty,
    purpose: row.purpose,
  });
}

export function contactSummary(
  row: ContactDto,
): Pick<
  ContactDto,
  "id" | "kind" | "displayName" | "customerNumber" | "category" | "parentOrganisationId"
> {
  return compact({
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    customerNumber: row.customerNumber,
    category:
      row.category === undefined
        ? undefined
        : compact({ id: row.category.id, key: row.category.key }),
    parentOrganisationId: row.parentOrganisationId,
  });
}

export const partSummarySchema = z.strictObject({
  id: z.number().int(),
  partNumber: optionalText,
  name: z.string(),
  unitId: optionalId,
  active: z.boolean().optional(),
  stock: optionalText,
  stockEnabled: z.boolean(),
  priceGross: moneySchema.shape.amount.optional().describe("Gross sales price in currency."),
  currency: currency.optional(),
});

export function partSummary(
  row: z.output<typeof partDtoSchema>,
): z.output<typeof partSummarySchema> {
  return compact({
    id: row.id,
    partNumber: row.partNumber,
    name: row.name,
    unitId: row.unitId,
    priceGross: row.priceGross?.amount,
    currency: row.priceGross?.currency,
    stock: row.stock,
    stockEnabled: row.stockEnabled,
    active: row.active,
  });
}
