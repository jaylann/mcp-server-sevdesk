import { z } from "zod";

import { dateRangeInputShape } from "../../domain/common.js";
import {
  documentListData,
  documentListSummary,
  localFilterOutputShape,
} from "../../domain/document-positions.js";
import {
  listDetailInputShape,
  voucherSummary,
  voucherSummarySchema,
} from "../../domain/list-summary.js";
import { pageOutputShape, pagingInputShape } from "../../domain/paging.js";
import {
  listVouchers,
  VOUCHER_KINDS,
  VOUCHER_STATUS_KEYS,
  VOUCHER_TYPE_KEYS,
  voucherDtoSchema,
} from "../../domain/vouchers.js";
import { defineTool } from "../define-tool.js";

const output = z.object({
  items: z.array(z.union([voucherDtoSchema, voucherSummarySchema])),
  ...pageOutputShape,
  ...localFilterOutputShape,
});

/** `sevdesk_vouchers_list`: find receipts (Belege) with sevDesk's own filters. */
export const vouchersListTool = defineTool({
  name: "sevdesk_vouchers_list",
  title: "List sevDesk vouchers",
  description:
    "List vouchers (Belege): receipts and supplier invoices (Ausgaben, kind=expense) and other " +
    "income documents (Einnahmen, kind=revenue). Filter by status (draft = Entwurf, open = " +
    "offen/fällig, transferred = überwiesen, partially_paid, paid = bezahlt), kind, supplier " +
    "contact id or supplier name, Belegnummer/description, voucher date range and type " +
    "(normal or recurring). Filters run in sevDesk; the type is also re-checked here (then " +
    "rows are scanned, total is left out and filteredLocally is set). Exact amounts. " +
    "Paged: pass nextOffset as offset while hasMore is true. Use detail=summary to browse/find. Use sevdesk_voucher_get for positions, tax rule and booking accounts. " +
    "Find supplier ids with sevdesk_contacts_search.",
  toolset: "vouchers",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    ...listDetailInputShape,
    status: z.enum(VOUCHER_STATUS_KEYS).optional().describe("Voucher status by name."),
    kind: z
      .enum(VOUCHER_KINDS)
      .optional()
      .describe("expense (Ausgabe, creditDebit C) or revenue (Einnahme, creditDebit D)."),
    supplierId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("Contact id of the supplier (Lieferant) or customer."),
    supplierName: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Part of the supplier name, for vouchers without a contact too."),
    description: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Part of the Belegnummer or description, e.g. an invoice number."),
    ...dateRangeInputShape,
    type: z.enum(VOUCHER_TYPE_KEYS).optional().describe("normal (VOU) or recurring (RV)."),
    ...pagingInputShape({ limit: 25, max: 100 }),
  }),
  output,
  handler: async (args, ctx) => {
    const { items, window, state, filteredLocally } = await listVouchers(
      ctx.client,
      args,
      ctx.signal,
    );
    const page = {
      items,
      received: window.received,
      total: window.total,
      ...state,
      filteredLocally: filteredLocally === true,
    };
    return {
      data: {
        ...documentListData(page, args),
        items: args.detail === "summary" ? items.map(voucherSummary) : [...items],
      },
      summary: documentListSummary("Vouchers", "matching vouchers", page, args),
    };
  },
});
