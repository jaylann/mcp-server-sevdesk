/**
 * The period arguments of the M4 report and export tools: `year` (alone, or with `month` or
 * `quarter`) or `from`/`to`. `resolvePeriod` (`src/domain/reports/vat.ts`) checks that exactly
 * one form is used.
 */
import { z } from "zod";

import { isoDateInput } from "../../domain/common.js";

/** Spread into a tool's `z.strictObject({...})`. */
export const periodInputShape = {
  year: z
    .number()
    .int()
    .min(2000)
    .max(2100)
    .optional()
    .describe("Calendar year; alone for the whole year, or with month or quarter."),
  month: z.number().int().min(1).max(12).optional().describe("Month 1–12 (with year)."),
  quarter: z.number().int().min(1).max(4).optional().describe("Quarter 1–4 (with year)."),
  from: isoDateInput.optional().describe("First day, YYYY-MM-DD (instead of year)."),
  to: isoDateInput.optional().describe("Last day, YYYY-MM-DD (instead of year)."),
};
