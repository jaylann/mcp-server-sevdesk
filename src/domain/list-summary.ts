/**
 * Browsing projections of normalized list rows. Full rows remain the default; summaries never
 * re-read upstream fields, so date serialization, currency selection and text cleaning stay
 * identical. List output unions put the full schema first to retain its field order even when
 * a sparse full row also fits the summary shape. Summary schemas reject extra fields so a
 * malformed full row cannot silently fall back to a stripped summary. Unknown status/type keys are omitted, not replaced with invented filter values.
 */
import { z } from "zod";

import { transactionDtoSchema } from "./banking.js";
import { compact, moneySchema, statusDtoSchema } from "./common.js";
import { contactDtoSchema } from "./contacts.js";
import { creditNoteRowSchema } from "./credit-notes.js";
import { invoiceRowSchema } from "./invoices.js";
import { money, subtract } from "./money.js";
import { orderRowSchema } from "./orders.js";
import { partDtoSchema } from "./parts.js";
import { voucherDtoSchema } from "./vouchers.js";

export const listDetailInputShape = {
  detail: z
    .enum(["summary", "full"])
    .default("full")
    .describe("Use summary to browse/find; full (default) or the matching get tool for details."),
};

const status = statusDtoSchema.shape.key;
const gross = moneySchema.shape.amount.optional().describe("Gross total in currency.");

export const invoiceSummarySchema = invoiceRowSchema
  .pick({
    id: true,
    number: true,
    contact: true,
    date: true,
    dueDate: true,
    overdue: true,
    currency: true,
    cancelsInvoiceId: true,
  })
  .extend({
    type: invoiceRowSchema.shape.type.shape.key,
    status,
    gross,
    openAmount: moneySchema.shape.amount
      .optional()
      .describe(
        "Gross minus paid, in currency; absent when either amount or its currency is unknown.",
      ),
  })
  .strict();

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
      total !== undefined && paid !== undefined && total.currency === paid.currency
        ? money(subtract(total.amount, paid.amount), total.currency).amount
        : undefined,
    cancelsInvoiceId: row.cancelsInvoiceId,
  });
}

export const creditNoteSummarySchema = creditNoteRowSchema
  .pick({
    id: true,
    number: true,
    contact: true,
    date: true,
    currency: true,
    sourceInvoiceId: true,
    sourceVoucherId: true,
  })
  .extend({ status, gross })
  .strict();

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

export const orderSummarySchema = orderRowSchema
  .pick({
    id: true,
    number: true,
    contact: true,
    date: true,
    currency: true,
  })
  .extend({ type: orderRowSchema.shape.type.shape.key, status, gross })
  .strict();

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

export const voucherSummarySchema = voucherDtoSchema
  .pick({
    id: true,
    number: true,
    supplier: true,
    date: true,
    paymentDeadline: true,
    kind: true,
    type: true,
    currency: true,
    warnings: true,
  })
  .extend({ status, gross })
  .strict();

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

export const transactionSummarySchema = transactionDtoSchema
  .pick({
    id: true,
    account: true,
    valueDate: true,
    entryDate: true,
    counterparty: true,
    purpose: true,
  })
  .extend({ status, amount: moneySchema.shape.amount, currency: moneySchema.shape.currency })
  .strict();

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

export const contactSummarySchema = contactDtoSchema
  .pick({
    id: true,
    kind: true,
    displayName: true,
    customerNumber: true,
    parentOrganisationId: true,
  })
  .extend({
    category: contactDtoSchema.shape.category
      .unwrap()
      .pick({ id: true, key: true })
      .strict()
      .optional(),
  })
  .strict();

export function contactSummary(
  row: z.output<typeof contactDtoSchema>,
): z.output<typeof contactSummarySchema> {
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

export const partSummarySchema = partDtoSchema
  .pick({
    id: true,
    partNumber: true,
    name: true,
    unitId: true,
    active: true,
    stock: true,
    stockEnabled: true,
  })
  .extend({
    priceGross: moneySchema.shape.amount.optional().describe("Gross sales price in currency."),
    currency: moneySchema.shape.currency.optional(),
  })
  .strict();

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
