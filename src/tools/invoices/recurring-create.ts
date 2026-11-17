/**
 * `sevdesk_invoice_create_recurring`: a new recurring invoice template (Abo-Rechnung, type WKR),
 * from which sevDesk creates a draft invoice on every run date by itself while automatic
 * generation is on (`src/domain/recurring/create.ts`; spec/deviations.md D-111, D-112, D-132).
 *
 * Its own tool, not a `recurring` argument on the draft tools: a template makes sevDesk create
 * invoices later without asking anyone, which binds in a way a draft does not, so it is commit
 * tier and a human confirms the preview (positions, totals per invoice, the next run dates,
 * automatic generation). The approval is bound to the exact body sent. Closed world
 * (`openWorldHint: false`): what sevDesk creates are drafts in the account, never finalized and
 * never sent, and the tool never sets automatic sending, so nothing leaves sevDesk. Finalizing and
 * sending a generated draft take their own approvals. `idempotentHint: false`: every call creates
 * another template. Calls run one at a time per account (`ACCOUNT_RECURRING_INVOICES`), so the
 * duplicate check of the second sees the template the first created.
 */
import { z } from "zod";

import { positionDtoSchema } from "../../domain/document-positions.js";
import { invoiceDetailSchema } from "../../domain/invoices.js";
import {
  executeRecurringInvoiceCreate,
  prepareRecurringInvoiceCreate,
  recurringInvoiceCreateInputShape,
} from "../../domain/recurring/create.js";
import { INTERVALS, storedScheduleSchema } from "../../domain/recurring/schedule.js";
import { defineWriteTool } from "../define-tool.js";
import { ACCOUNT_RECURRING_INVOICES } from "../types.js";
import { dryRunInputShape } from "../write-input.js";

const output = z.object({
  invoice: invoiceDetailSchema.describe("The template as sevDesk stored it (type WKR, no number)."),
  positions: z.array(positionDtoSchema).describe("Positionen of every invoice, as stored."),
  positionsComplete: z
    .boolean()
    .describe("False when sevDesk had more position rows than could be read back."),
  schedule: storedScheduleSchema.describe("The schedule as sevDesk stored it."),
  notes: z
    .array(z.string())
    .optional()
    .describe("Where sevDesk stored something else than was sent; check those in sevDesk."),
});

/** `sevdesk_invoice_create_recurring`: creates a recurring invoice template. */
export const invoiceCreateRecurringTool = defineWriteTool({
  name: "sevdesk_invoice_create_recurring",
  title: "Create a recurring invoice template",
  description:
    "Create a recurring invoice template (Abo-Rechnung, wiederkehrende Rechnung, type WKR) for a " +
    "contact, e.g. a monthly retainer, rent or subscription. With autoGenerate (Automatische " +
    "Generierung, default true), sevDesk creates a draft invoice from it on every run date by " +
    "itself, within about a minute; the drafts are neither finalized nor sent and carry a " +
    "provisional number until finalized. With autoGenerate false, sevDesk creates nothing until " +
    "it is switched on (sevdesk_invoice_update_recurring). This tool never switches on sevDesk's automatic " +
    "sending by e-mail. Customer, positions, texts, payment term and tax rule work as in " +
    "sevdesk_invoice_create_draft (EUR only), plus the schedule: interval monthly, quarterly, " +
    "half_yearly or yearly; startDate, the first run (today or later, on day 1–28; later runs " +
    "fall on the same day of the month); endDate optional. The draft tool's checks apply (tax " +
    "rule and rates for the account, address, contact person), and the total must be above " +
    "zero. Commit tier: a human confirms the preview, which lists the positions, the total per " +
    "invoice, the next run dates and what sevDesk does on a run date; dryRun only previews. The " +
    "preview warns when the customer has a template with the same total already. Changing or " +
    "ending a template: sevdesk_invoice_update_recurring, sevdesk_invoice_end_recurring. Before: " +
    "sevdesk_contacts_search for contactId. After: sevdesk_invoices_list with type recurring, " +
    "sevdesk_invoice_get; a generated draft is finalized and sent like any draft " +
    "(sevdesk_invoice_finalize, sevdesk_invoice_send_email).",
  toolset: "invoices",
  tier: "commit",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({ ...recurringInvoiceCreateInputShape, ...dryRunInputShape }),
  output,
  // Serialized with other creations in the account (see ACCOUNT_RECURRING_INVOICES).
  locks: () => [ACCOUNT_RECURRING_INVOICES],
  prepare: (args, ctx) =>
    prepareRecurringInvoiceCreate(ctx.client, args, { signal: ctx.signal, cacheOwner: ctx.config }),
  execute: async (_args, plan, ctx) => {
    const result = await executeRecurringInvoiceCreate(ctx.client, plan.state, {
      signal: ctx.signal,
      cacheOwner: ctx.config,
    });
    const { invoice, positions, positionsComplete } = result.details;
    const { schedule } = plan.state;
    const gross = invoice.totals.gross;
    const total =
      gross === undefined ? "" : `, gross ${gross.amount} ${gross.currency} per invoice`;
    const generation = plan.state.body.invoice.propertyAutoGenerateRecurringInvoice ? "on" : "off";
    return {
      data: {
        invoice,
        positions: [...positions],
        positionsComplete,
        schedule: result.schedule,
        ...(result.notes.length === 0 ? {} : { notes: [...result.notes] }),
      },
      summary:
        `Created recurring invoice template ${String(result.id)} ` +
        `(${INTERVALS[schedule.interval].en} from ${schedule.startDate}${total}, automatic ` +
        `generation ${generation}).` +
        (result.notes.length === 0 ? "" : " See notes."),
      affected: [{ objectName: "Invoice", id: String(result.id) }],
    };
  },
});
