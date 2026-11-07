import { z } from "zod";

import {
  cashPosition,
  cashPositionSchema,
  cashPositionSentence,
} from "../../domain/reports/cash.js";
import { isIsoDate } from "../../sevdesk/dates.js";
import { defineTool } from "../define-tool.js";

/** `sevdesk_cash_position`: balances per account and currency, optional expected outlook. */
export const cashPositionTool = defineTool({
  name: "sevdesk_cash_position",
  title: "Cash position",
  description:
    "Liquidität: balance (Kontostand) of every payment account (Zahlungskonto) on asOf as " +
    "sevDesk computes it, with totals per currency. With outlookDays it adds an expected view " +
    "from today to asOf + N days: receivables (Forderungen) and payables (Verbindlichkeiten) " +
    "due by due date (Zahlungsziel/Fälligkeit), expected net and projected balance, labelled " +
    "expected, not booked; overdue items are shown apart, and asOf must then be today or " +
    "later. Prefer it over combining " +
    "sevdesk_bank_accounts_list with invoice and voucher lists. Computed by this server from " +
    "sevDesk records, not a sevDesk report.",
  toolset: "reports",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    asOf: z
      .string()
      .refine(isIsoDate, { message: "expected a calendar date as YYYY-MM-DD" })
      .optional()
      .describe(
        "Day of the balances (Stichtag), YYYY-MM-DD; default today (Berlin). With outlookDays " +
          "it must be today or later (sevDesk only knows today's open items).",
      ),
    outlookDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Add the expected in- and outflows due within this many days after asOf."),
    includeArchived: z
      .boolean()
      .default(false)
      .describe("Also list archived accounts (archiviert)."),
  }),
  output: cashPositionSchema,
  handler: async (args, ctx) => {
    const report = await cashPosition(ctx.client, args, {
      signal: ctx.signal,
      onProgress: (done, total, message) => ctx.progress(done, total, message),
    });
    return { data: report, summary: cashPositionSentence(report) };
  },
});
