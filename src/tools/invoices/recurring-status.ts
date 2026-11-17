/**
 * `sevdesk_invoice_end_recurring` and `sevdesk_invoice_reactivate_recurring`: end a recurring
 * invoice template (Abo-Rechnung, type WKR) or start it again
 * (`src/domain/recurring/status.ts`; spec/deviations.md D-112).
 *
 * Two tools, not one with an action argument: their consequences are opposite (ending stops
 * billing a customer, reactivating makes sevDesk issue invoices again without asking anyone), so
 * each has its own description and preview, and a wrong flag cannot turn one into the other. Both
 * are commit tier with a human confirming the preview, bound to the exact body. Both are
 * idempotent: the same call again is refused as changing nothing. Calls run one at a time per
 * account (`ACCOUNT_RECURRING_INVOICES`) and per template.
 */
import { z } from "zod";

import { invoiceDetailSchema } from "../../domain/invoices.js";
import { storedScheduleSchema } from "../../domain/recurring/schedule.js";
import {
  executeTemplateStatus,
  prepareTemplateStatus,
  type TemplateStatusResult,
} from "../../domain/recurring/status.js";
import { templateIdInput } from "../../domain/recurring/template.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_RECURRING_INVOICES, type SevdeskObjectRef } from "../types.js";
import { dryRunInputShape } from "../write-input.js";

const output = z.object({
  invoice: invoiceDetailSchema.describe("The template as sevDesk stores it now (type WKR)."),
  schedule: storedScheduleSchema.describe("The schedule as sevDesk stores it now."),
  notes: z
    .array(z.string())
    .optional()
    .describe("Where sevDesk stored something else than expected; check those in sevDesk."),
});

const input = z.strictObject({ id: templateIdInput, ...dryRunInputShape });

/** Serialized with template creations in the account and other calls on the same template. */
function templateLocks(args: { readonly id: number }): SevdeskObjectRef[] {
  return [ACCOUNT_RECURRING_INVOICES, { objectName: "Invoice", id: String(args.id) }];
}

function toolOutput(result: TemplateStatusResult, done: string) {
  return {
    data: {
      invoice: result.invoice,
      schedule: result.schedule,
      ...(result.notes.length === 0 ? {} : { notes: [...result.notes] }),
    },
    summary:
      `${done} recurring invoice template ${String(result.id)} (status ` +
      `${String(result.invoice.status.code)}).` +
      (result.notes.length === 0 ? "" : " See notes."),
    affected: [{ objectName: "Invoice", id: String(result.id) }],
  };
}

/** `sevdesk_invoice_end_recurring`: ends a recurring invoice template (status 50). */
export const invoiceEndRecurringTool = defineWriteTool({
  name: "sevdesk_invoice_end_recurring",
  title: "End a recurring invoice template",
  description:
    "End a recurring invoice template (Abo-Rechnung, type WKR), e.g. a cancelled subscription " +
    "or contract: sevDesk then creates no further invoice from it (status 50, deactivated). " +
    "Invoices it already created stay as they are (not cancelled or changed); the template " +
    "keeps its positions and schedule and can be started again with " +
    "sevdesk_invoice_reactivate_recurring. Deleting a template: the sevDesk web app. An ended " +
    "template is refused. Commit tier: a human confirms the preview (customer, interval, the " +
    "next run that no longer happens, total per invoice); dryRun only previews. Before: " +
    "sevdesk_invoices_list with type recurring, sevdesk_invoice_get.",
  toolset: "invoices",
  tier: "commit",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input,
  output,
  locks: templateLocks,
  prepare: (args, ctx) => prepareTemplateStatus(ctx.client, args.id, "end", ctx.signal),
  execute: async (_args, plan, ctx) =>
    toolOutput(await executeTemplateStatus(ctx.client, plan.state, ctx.signal), "Ended"),
});

/** `sevdesk_invoice_reactivate_recurring`: starts an ended recurring invoice template again. */
export const invoiceReactivateRecurringTool = defineWriteTool({
  name: "sevdesk_invoice_reactivate_recurring",
  title: "Reactivate a recurring invoice template",
  description:
    "Start an ended recurring invoice template (Abo-Rechnung, type WKR, status 50) again: " +
    "sevDesk then creates an invoice from it on every run date by itself, from its kept next " +
    "run on. Refused for an active template, and when the kept next run is in the past (sevDesk " +
    "could create the missed invoices at once): give it a new startDate with " +
    "sevdesk_invoice_update_recurring first. Commit tier: a human confirms the preview " +
    "(customer, total per invoice, the next run dates, what sevDesk does on a run date); dryRun " +
    "only previews. Before: sevdesk_invoices_list with type recurring, sevdesk_invoice_get.",
  toolset: "invoices",
  tier: "commit",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input,
  output,
  locks: templateLocks,
  prepare: (args, ctx) => prepareTemplateStatus(ctx.client, args.id, "reactivate", ctx.signal),
  execute: async (_args, plan, ctx) =>
    toolOutput(await executeTemplateStatus(ctx.client, plan.state, ctx.signal), "Reactivated"),
});
