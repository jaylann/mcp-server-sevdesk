import { z } from "zod";

import {
  agingSentence,
  payablesAging,
  payablesAgingSchema,
  receivablesAging,
  receivablesAgingSchema,
} from "../../domain/reports/aging.js";
import { isIsoDate } from "../../sevdesk/dates.js";
import { defineTool } from "../define-tool.js";

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const asOf = z
  .string()
  .refine(isIsoDate, { message: "expected a calendar date as YYYY-MM-DD" })
  .optional()
  .describe(
    "Reference day (Stichtag), YYYY-MM-DD, today or later; default today (Berlin). sevDesk " +
      "only knows today's open items, so a past day is refused; a later day ages today's open " +
      "items as of that day.",
  );

const top = z
  .number()
  .int()
  .min(1)
  .max(50)
  .default(10)
  .describe("How many of the largest parties to list per currency.");

/** `sevdesk_receivables_aging`: open invoices by days overdue (offene Posten, Forderungen). */
export const receivablesAgingTool = defineTool({
  name: "sevdesk_receivables_aging",
  title: "Receivables aging",
  description:
    "Offene Posten / Forderungen: today's open and partially paid invoices by days overdue on " +
    "asOf (Stichtag, today or later; due date = invoice date + Zahlungsziel): not due, 1–30, " +
    "31–60, 61–90, over 90 days, each with count and outstanding = gross − paid per currency, " +
    "plus the top debtors. Use it for dunning (Mahnwesen) or 'who owes us what'; " +
    "sevdesk_invoices_list with overdueOnly shows the single invoices. Amounts without a usable " +
    "paid figure are marked approximate or unknown; SR, WKR templates and MA reminders are left " +
    "out, negative invoices listed apart. Computed by this server from sevDesk records, not a " +
    "sevDesk report.",
  toolset: "reports",
  tier: "read",
  annotations: READ_ANNOTATIONS,
  input: z.strictObject({ asOf, top }),
  output: receivablesAgingSchema,
  handler: async (args, ctx) => {
    const report = await receivablesAging(ctx.client, args, {
      signal: ctx.signal,
      onProgress: (done, total, message) => ctx.progress(done, total, message),
    });
    return { data: report, summary: agingSentence("Receivables", report) };
  },
});

/** `sevdesk_payables_aging`: open expense vouchers by days overdue (Verbindlichkeiten). */
export const payablesAgingTool = defineTool({
  name: "sevdesk_payables_aging",
  title: "Payables aging",
  description:
    "Verbindlichkeiten / offene Posten: today's open and partially paid expense vouchers " +
    "(Belege, Ausgaben) by days past their payment deadline (Fälligkeit) on asOf (Stichtag, " +
    "today or later): not due, 1–30, 31–60, 61–90, over 90 days, each with count and " +
    "outstanding = gross − paid per currency, plus the top suppliers (Lieferanten). Use it to " +
    "plan payments; sevdesk_vouchers_list shows the single vouchers. Transferred vouchers " +
    "(Überwiesen) count as paid, recurring templates (RV) are left out; amounts without a " +
    "usable paid figure are marked approximate or unknown. Computed by this server from " +
    "sevDesk records, not a sevDesk report.",
  toolset: "reports",
  tier: "read",
  annotations: READ_ANNOTATIONS,
  input: z.strictObject({ asOf, top }),
  output: payablesAgingSchema,
  handler: async (args, ctx) => {
    const report = await payablesAging(ctx.client, args, {
      signal: ctx.signal,
      onProgress: (done, total, message) => ctx.progress(done, total, message),
    });
    return { data: report, summary: agingSentence("Payables", report) };
  },
});
