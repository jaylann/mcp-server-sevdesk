import { z } from "zod";

import { dateRangeInputShape } from "../../domain/common.js";
import { REPORT_SCAN_MAX } from "../../domain/reports/shared.js";
import {
  INVOICE_TYPE_KEYS,
  summarizeRecords,
  SUMMARY_GROUPINGS,
  SUMMARY_STATUS_KEYS,
  SUMMARY_SUBJECTS,
  summaryReportSchema,
  summaryReportSentence,
} from "../../domain/reports/summarize.js";
import { VOUCHER_KINDS } from "../../domain/vouchers.js";
import { defineTool } from "../define-tool.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** `sevdesk_records_summarize`: counts and exact sums, optionally grouped. */
export const recordsSummarizeTool = defineTool({
  name: "sevdesk_records_summarize",
  title: "Summarize sevDesk records",
  description:
    "Auswertung: counts and exact sums of invoices (Rechnungen), credit notes (Gutschriften), " +
    "vouchers (Belege) or bank transactions (Umsätze): net/tax/gross per currency (incoming/" +
    "outgoing for transactions), optionally grouped by month, quarter, status, contact " +
    "(Kunde/Lieferant) or account. Prefer it over paging list tools for totals such as revenue " +
    "per month (Umsatz), expenses per supplier or amounts per status. Filters: from/to, " +
    "status, contactId, kind (vouchers: expense/revenue), invoiceType, checkAccountId " +
    "(transactions). Templates (recurring RV/WKR) and reminders (MA) are left out unless " +
    `invoiceType asks for them. Reads up to ${REPORT_SCAN_MAX.toLocaleString("en-US")} rows; ` +
    "truncated says if more existed. " +
    "Computed by this server from sevDesk records, not a sevDesk report.",
  toolset: "reports",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    subject: z
      .enum(SUMMARY_SUBJECTS)
      .describe("invoices, credit_notes, vouchers or transactions (bank transactions)."),
    groupBy: z
      .enum(SUMMARY_GROUPINGS)
      .default("none")
      .describe(
        "none, month, quarter, status, contact (customer/supplier; not for transactions) or " +
          "account (transactions only).",
      ),
    ...dateRangeInputShape,
    status: z
      .enum(SUMMARY_STATUS_KEYS)
      .optional()
      .describe(
        "Invoices/credit notes: draft, open, partially_paid, paid. Vouchers: draft, open, " +
          "transferred, partially_paid, paid. Transactions: created, linked, private, " +
          "auto_booked, booked.",
      ),
    contactId: id
      .optional()
      .describe("Customer (invoices, credit notes) or supplier (vouchers) contact id."),
    kind: z
      .enum(VOUCHER_KINDS)
      .optional()
      .describe("Vouchers only: expense (Ausgabe) or revenue (Einnahme)."),
    invoiceType: z
      .enum(INVOICE_TYPE_KEYS)
      .optional()
      .describe(
        "Invoices only: invoice (RE), advance (AR), partial (TR), final (ER), cancellation (SR), " +
          "reminder (MA) or recurring (WKR template); reminders and templates count only when " +
          "asked for here.",
      ),
    checkAccountId: id
      .optional()
      .describe("Transactions only: payment account (Zahlungskonto) id."),
    maxGroups: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe("Most groups to return; the rest are counted in groupsOmitted."),
  }),
  output: summaryReportSchema,
  handler: async (args, ctx) => {
    const report = await summarizeRecords(ctx.client, args, {
      signal: ctx.signal,
      onProgress: (done, total, message) => ctx.progress(done, total, message),
    });
    return { data: report, summary: summaryReportSentence(report) };
  },
});
