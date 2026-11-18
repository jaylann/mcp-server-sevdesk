/**
 * `sevdesk_invoice_update_recurring`: changes a recurring invoice template (Abo-Rechnung, type WKR)
 * (`src/domain/recurring/update.ts`; spec/deviations.md D-111, D-112).
 *
 * Commit tier, like the create tool: every invoice sevDesk creates from the template afterwards
 * carries the change without asking anyone, so a human confirms the preview (each change before →
 * after, new positions and texts in full, the total per invoice, the run dates after the change).
 * The approval is bound to the exact body. `idempotentHint: true`: the same call again leaves the
 * template as the first left it (the second is refused as changing nothing). Calls run one at a
 * time per account (`ACCOUNT_RECURRING_INVOICES`) and per template.
 */
import { z } from "zod";

import { documentDiscountSchema } from "../../domain/document-discounts.js";
import { positionDtoSchema } from "../../domain/document-positions.js";
import { invoiceDetailSchema } from "../../domain/invoices.js";
import { storedScheduleSchema } from "../../domain/recurring/schedule.js";
import {
  executeRecurringInvoiceUpdate,
  prepareRecurringInvoiceUpdate,
  recurringInvoiceUpdateInputShape,
} from "../../domain/recurring/update.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_RECURRING_INVOICES } from "../types.js";
import { dryRunInputShape } from "../write-input.js";

const output = z.object({
  invoice: invoiceDetailSchema.describe("The template as sevDesk stores it now (type WKR)."),
  positions: z.array(positionDtoSchema).describe("Positionen of every later invoice, as stored."),
  positionsComplete: z
    .boolean()
    .describe("False when not every position could be read back for certain."),
  schedule: storedScheduleSchema.describe("The schedule as sevDesk stores it now."),
  discount: documentDiscountSchema
    .optional()
    .describe(
      "Discount on the whole template (Rabatt) as stored now; left out when there is none. The " +
        "change never sets it.",
    ),
  notes: z
    .array(z.string())
    .optional()
    .describe("Where sevDesk stored something else than was sent; check those in sevDesk."),
});

/** `sevdesk_invoice_update_recurring`: changes a recurring invoice template. */
export const invoiceUpdateRecurringTool = defineWriteTool({
  name: "sevdesk_invoice_update_recurring",
  title: "Change a recurring invoice template",
  description:
    "Change a recurring invoice template (Abo-Rechnung, type WKR), e.g. a new price, new " +
    "positions, texts, another interval or end date, or switch its automatic generation " +
    "(autoGenerate) on or off. Only the fields you give change. positions replace ALL " +
    "positions; priceMode needs positions too. Content works as in " +
    "sevdesk_invoice_update_draft (tax rule and rates for the account, contact, address). " +
    "Schedule: interval (the next run date stays), endDate or removeEndDate, startDate (also " +
    "the next run; after today, day 1–28, and after the period of the newest invoice the " +
    "template generated). Switching autoGenerate on is refused while the next run is before " +
    "today, unless startDate is given. A template with automatic sending on, or whose settings " +
    "sevDesk does not return, is refused (the web app manages it). Templates made in the web " +
    "app work too; an interval this server does not offer stays as it is. Invoices sevDesk " +
    "already created stay as they are. Commit tier: a human confirms the preview (each change " +
    "before → after, the total per invoice, the next run dates, what sevDesk does on a run " +
    "date); dryRun only previews. Ending: sevdesk_invoice_end_recurring. Before: " +
    "sevdesk_invoice_get. After: sevdesk_invoice_get.",
  toolset: "invoices",
  tier: "commit",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.strictObject({ ...recurringInvoiceUpdateInputShape, ...dryRunInputShape }),
  output,
  // Serialized with template creations in the account and other calls on the same template.
  locks: (args) => [ACCOUNT_RECURRING_INVOICES, { objectName: "Invoice", id: String(args.id) }],
  prepare: (args, ctx) =>
    prepareRecurringInvoiceUpdate(ctx.client, args, { signal: ctx.signal, cacheOwner: ctx.config }),
  execute: async (_args, plan, ctx) => {
    const result = await executeRecurringInvoiceUpdate(ctx.client, plan.state, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
    const { invoice, positions, positionsComplete, discount } = result.details;
    return {
      data: {
        invoice,
        positions: [...positions],
        positionsComplete,
        schedule: result.schedule,
        ...(discount === undefined ? {} : { discount }),
        ...(result.notes.length === 0 ? {} : { notes: [...result.notes] }),
      },
      summary:
        `Changed recurring invoice template ${String(result.id)} ` +
        `(${plan.state.changed.join(", ")}).` +
        (result.notes.length === 0 ? "" : " See notes."),
      affected: [{ objectName: "Invoice", id: String(result.id) }],
    };
  },
});
