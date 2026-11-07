import { z } from "zod";

import {
  CHANGE_SCAN_MAX_ROWS,
  CHANGE_SUBJECTS,
  changedSince,
  changesReportSchema,
  changesSentence,
} from "../../domain/reports/changes.js";
import { defineTool } from "../define-tool.js";

/** `sevdesk_changed_since`: records updated at or after a point in time. */
export const changedSinceTool = defineTool({
  name: "sevdesk_changed_since",
  title: "Changes since",
  description:
    "What changed in sevDesk since a point in time (sevDesk has no webhooks): contacts, " +
    "invoices (Rechnungen), credit notes (Gutschriften), orders (Angebote/Aufträge), vouchers " +
    "(Belege) and bank transactions (Umsätze) last updated at or after since, as compact rows " +
    "(id, type, number/name, status, update time, link) with per-subject counts. Use it to " +
    "sync or review recent changes instead of paging every list; details via the get tools. Up " +
    "to limit rows per subject; to page on, pass one subject with offset = nextOffset. Credit " +
    "notes and transactions have no sevDesk change filter and are checked here (up to " +
    `${CHANGE_SCAN_MAX_ROWS.toLocaleString("en-US")} rows per call). Deleted records do not ` +
    "appear.",
  toolset: "reports",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({
    since: z
      .string()
      .trim()
      .min(10)
      .max(40)
      .describe(
        "Start: YYYY-MM-DD (00:00 Berlin) or an ISO 8601 date-time, e.g. " +
          "2026-11-01T08:00:00+01:00 (Berlin time without an offset).",
      ),
    subjects: z
      .array(z.enum(CHANGE_SUBJECTS))
      .min(1)
      .max(CHANGE_SUBJECTS.length)
      .default([...CHANGE_SUBJECTS])
      .describe("Which records to check; default all."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("Changed records to return per subject, 1–100."),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("sevDesk rows to skip (a previous nextOffset); only with exactly one subject."),
  }),
  output: changesReportSchema,
  handler: async (args, ctx) => {
    const report = await changedSince(ctx.client, args, {
      signal: ctx.signal,
      onProgress: (done, total, message) => ctx.progress(done, total, message),
    });
    return { data: report, summary: changesSentence(report) };
  },
});
