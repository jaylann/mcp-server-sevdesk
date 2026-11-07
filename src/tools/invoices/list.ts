import { z } from "zod";

import { dateRangeInputShape } from "../../domain/common.js";
import {
  documentListData,
  documentListSummary,
  localFilterOutputShape,
} from "../../domain/document-positions.js";
import {
  INVOICE_STATUS_FILTERS,
  INVOICE_TYPE_FILTERS,
  invoiceRowSchema,
  type InvoiceStatusFilter,
  type InvoiceTypeFilter,
  listInvoices,
} from "../../domain/invoices.js";
import { pageOutputShape, pagingInputShape } from "../../domain/paging.js";
import { defineTool } from "../define-tool.js";

const STATUS_KEYS = Object.keys(INVOICE_STATUS_FILTERS) as [
  InvoiceStatusFilter,
  ...InvoiceStatusFilter[],
];
const TYPE_KEYS = Object.keys(INVOICE_TYPE_FILTERS) as [InvoiceTypeFilter, ...InvoiceTypeFilter[]];

const output = z.object({
  items: z.array(invoiceRowSchema),
  ...pageOutputShape,
  ...localFilterOutputShape,
});

/** `sevdesk_invoices_list`: find invoices by status, type, contact, number, date or overdue. */
export const invoicesListTool = defineTool({
  name: "sevdesk_invoices_list",
  title: "List sevDesk invoices",
  description:
    "List invoices (Rechnungen): number, type, status, customer, date, due date, " +
    "net/tax/gross, paid, sent/locked state, web link. Filters: status (draft = Entwurf, open " +
    "= offen, partially_paid, paid = bezahlt), type (invoice RE, advance AR Abschlagsrechnung, " +
    "partial TR, final ER, cancellation SR Stornorechnung, reminder MA Mahnung, recurring WKR), " +
    "contactId, exact number (Rechnungsnummer), date range, overdueOnly (open/partially paid " +
    "past the due date, überfällig). overdueOnly, type and number are checked here too (up to " +
    "1,000 rows scanned per call; total left out, filteredLocally set). A cancelled " +
    "invoice keeps status paid; its SR invoice has cancelsInvoiceId. Page with offset = " +
    "nextOffset while hasMore. Details: sevdesk_invoice_get.",
  toolset: "invoices",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    status: z
      .enum(STATUS_KEYS)
      .optional()
      .describe("draft (100), open (200), partially_paid (750) or paid (1000)."),
    type: z
      .enum(TYPE_KEYS)
      .optional()
      .describe("Invoice type: invoice (RE), advance, partial, final, cancellation, reminder…"),
    contactId: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("Only invoices of this contact (id from sevdesk_contacts_search)."),
    number: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe("Exact invoice number, e.g. 'RE-1000'."),
    ...dateRangeInputShape,
    overdueOnly: z
      .boolean()
      .default(false)
      .describe("Only open/partially paid invoices past their due date (Berlin time)."),
    ...pagingInputShape({ limit: 25, max: 100 }),
  }),
  output,
  handler: async (args, ctx) => {
    const result = await listInvoices(ctx.client, args, ctx.signal);
    return {
      data: documentListData(result, args),
      summary: documentListSummary(
        "Invoices",
        args.overdueOnly ? "overdue invoices" : "matching invoices",
        result,
        args,
      ),
    };
  },
});
