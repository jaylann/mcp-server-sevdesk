/**
 * Creating a recurring invoice template (Abo-Rechnung, invoice type WKR): sevDesk creates an
 * invoice from it on every run date by itself (spec/deviations.md D-111, D-112).
 *
 * The template is made of what an invoice draft is made of, resolved and checked by the same code
 * (`../drafts/invoice.ts`: `INVOICE_TAX_OPTIONS`, `newInvoiceContent`, `newInvoicePositions` over
 * `resolveCreateBasics`): tax rule and rates against the account's VAT regulation, units, contact,
 * address and contact person. What an invoice draft may not carry, a template may not either. On
 * top come the schedule (`schedule.ts`) and a total above zero.
 *
 * One `saveInvoice` without an id, never retried; then the template is read back (the invoice and
 * its positions, and the raw record for the schedule fields the invoice DTO does not carry) and
 * every way the stored schedule differs from the one sent becomes a note.
 */
import { z } from "zod";

import { canonicalJson, sha256Hex } from "../../safety/hashing.js";
import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../../sevdesk/paths.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { isoDateInput } from "../common.js";
import type { CountryReadOptions } from "../country-codes.js";
import {
  contactIdInput,
  contactPersonIdInput,
  footTextInput,
  headerInput,
  headTextInput,
  priceModeInput,
  taxRuleInput,
  taxTextInput,
  todayInBerlin,
  wireDocumentDate,
  wireTimestamp,
} from "../drafts/fields.js";
import {
  INVOICE_TAX_OPTIONS,
  type InvoiceContentArgs,
  invoiceCreateInputShape,
  newInvoiceContent,
  newInvoicePositions,
} from "../drafts/invoice.js";
import { savedDocumentId, strictBody } from "../drafts/payloads.js";
import type { Amounts } from "../drafts/positions.js";
import type { DraftPreview } from "../drafts/preview.js";
import { readBack } from "../drafts/read-back.js";
import { addressInputShape } from "../drafts/recipient.js";
import { type CreateArgs, type DraftCallOptions, resolveCreateBasics } from "../drafts/shared.js";
import { getInvoice, type InvoiceDetails, listInvoices } from "../invoices.js";
import { compare } from "../money.js";
import { type SaveTemplateBody, saveTemplateBodySchema } from "./payload.js";
import { templatePreviews } from "./preview.js";
import { TEMPLATE_SAVE_STATUS } from "./run-date.js";
import {
  checkSchedule,
  readStoredSchedule,
  RECURRING_INTERVALS,
  type Schedule,
  scheduleDifferences,
  type ScheduleInput,
  type StoredSchedule,
} from "./schedule.js";

const SAVE_PATH = "/Invoice/Factory/saveInvoice";
/** Status 50, "Deactivated recurring invoice" (D-112): such a template creates nothing. */
const DEACTIVATED_STATUS = 50;
/** Templates of the customer checked for a duplicate; a customer rarely has more. */
const SIMILAR_SCAN_LIMIT = 100;

/** Input fields of `sevdesk_invoice_create_recurring` (without `dryRun`). */
export const recurringInvoiceCreateInputShape = {
  contactId: contactIdInput,
  interval: z
    .enum(RECURRING_INTERVALS)
    .describe(
      "How often sevDesk creates an invoice: monthly, quarterly (every 3 months), half_yearly " +
        "(every 6 months) or yearly.",
    ),
  startDate: isoDateInput.describe(
    "Date of the first invoice, YYYY-MM-DD: today or later, at most a year ahead, on day 1–28 " +
      "of a month. Later runs fall on the same day of the month.",
  ),
  endDate: isoDateInput
    .optional()
    .describe(
      "No invoice after this date (Enddatum), YYYY-MM-DD, at most 10 years after startDate; " +
        "leave out to run until the template is ended.",
    ),
  positions: invoiceCreateInputShape.positions.describe(
    "Positionen of every invoice, in printed order; prices per priceMode.",
  ),
  timeToPay: invoiceCreateInputShape.timeToPay,
  priceMode: priceModeInput,
  taxRuleId: taxRuleInput,
  taxText: taxTextInput,
  header: headerInput.describe('Title (Betreff) of every invoice; default "Rechnung".'),
  headText: headTextInput,
  footText: footTextInput,
  contactPersonId: contactPersonIdInput,
  ...addressInputShape,
};

export interface RecurringInvoiceCreateArgs extends CreateArgs, InvoiceContentArgs, ScheduleInput {}

/** What `execute` needs: the exact body the preview describes, and what it promised. */
export interface RecurringInvoiceState {
  readonly body: SaveTemplateBody;
  readonly schedule: Schedule;
  readonly expected: Amounts;
}

export interface RecurringInvoicePlan {
  readonly preview: DraftPreview;
  readonly previewDe: DraftPreview;
  /** SHA-256 of the body, so the approval covers exactly what is sent. */
  readonly binding: string;
  readonly state: RecurringInvoiceState;
}

/**
 * Validates a new template (schedule first, so a refused schedule costs no request), reads what
 * its body needs, looks for a template of the same customer with the same total, and builds the
 * body and both previews. Throws `validation` errors; sends nothing.
 */
export async function prepareRecurringInvoiceCreate(
  client: SevdeskClient,
  args: RecurringInvoiceCreateArgs,
  options: DraftCallOptions,
): Promise<RecurringInvoicePlan> {
  const today = todayInBerlin();
  const schedule = checkSchedule(args, today);
  const basics = await resolveCreateBasics(client, args, INVOICE_TAX_OPTIONS, options);
  if (compare(basics.expected.gross, 0) <= 0) {
    throw new SevdeskError({
      kind: "validation",
      message:
        `Every invoice of this template would total ${basics.expected.gross} ` +
        `${basics.currency} gross. A recurring invoice must charge something: check the ` +
        "positions (a credit to the customer is a credit note, not a recurring invoice).",
    });
  }
  const similar = await findSimilarTemplates(client, args.contactId, basics, options.signal);

  const content = newInvoiceContent(args, basics);
  const body = strictBody(
    saveTemplateBodySchema,
    {
      invoice: {
        objectName: "Invoice",
        mapAll: true,
        invoiceType: "WKR",
        status: TEMPLATE_SAVE_STATUS,
        // The template's own dates: the first run. They do not drive the schedule (D-111).
        invoiceDate: wireDocumentDate(schedule.startDate),
        deliveryDate: wireTimestamp(schedule.startDate),
        ...content,
        accountIntervall: schedule.wire,
        accountStartDate: wireTimestamp(schedule.startDate),
        accountEndDate:
          schedule.endDate === undefined ? undefined : wireTimestamp(schedule.endDate),
      },
      invoicePosSave: newInvoicePositions(basics),
      invoicePosDelete: null,
    },
    "recurring invoice template",
  );

  return {
    ...templatePreviews({ contactId: args.contactId, basics, content, schedule, today, similar }),
    binding: sha256Hex(canonicalJson({ kind: "recurring-invoice-template", body })),
    state: { body, schedule, expected: basics.expected },
  };
}

/**
 * Ids of the customer's templates that are not deactivated and bill the same gross total in the
 * same currency: probably the same subscription created twice. Only warns (two subscriptions
 * with the same price can be legitimate).
 */
async function findSimilarTemplates(
  client: SevdeskClient,
  contactId: number,
  basics: { readonly expected: Amounts; readonly currency: string },
  signal: AbortSignal | undefined,
): Promise<number[]> {
  const { items } = await listInvoices(
    client,
    { type: "recurring", contactId, limit: SIMILAR_SCAN_LIMIT, offset: 0 },
    signal,
  );
  return items
    .filter(
      (row) =>
        row.contact?.id === contactId &&
        row.status.code !== DEACTIVATED_STATUS &&
        row.currency === basics.currency &&
        row.totals.gross !== undefined &&
        compare(row.totals.gross.amount, basics.expected.gross) === 0,
    )
    .map((row) => row.id)
    .sort((a, b) => a - b);
}

/** A saved template as read back, with trusted notes. */
export interface RecurringInvoiceResult {
  readonly id: number;
  readonly details: InvoiceDetails;
  readonly schedule: StoredSchedule;
  readonly notes: readonly string[];
}

/**
 * Sends the prepared body (one request, never retried) and reads the template back. A failing
 * read-back names the saved template as a completed write.
 */
export async function executeRecurringInvoiceCreate(
  client: SevdeskClient,
  state: RecurringInvoiceState,
  options: CountryReadOptions,
): Promise<RecurringInvoiceResult> {
  const { signal, cacheOwner } = options;
  const withSignal = signal === undefined ? {} : { signal };
  const response = await client.request({
    method: "POST",
    path: SAVE_PATH,
    body: state.body,
    ...withSignal,
  });
  const id = savedTemplateId(response);
  const saved = { objectName: "Invoice", id: String(id) };
  const { details, schedule } = await readBack(saved, async () => {
    const [read, record] = await Promise.all([
      getInvoice(client, id, { signal, cacheOwner }),
      // The raw record: the schedule fields beyond interval and next run are not in the DTO.
      client.request({
        method: "GET",
        path: sevdeskPath("Invoice", toSevdeskId(id)),
        query: { embed: "contact" },
        ...withSignal,
      }),
    ]);
    return {
      details: read,
      schedule: readStoredSchedule(expectSingle(record, `invoice ${String(id)}`)),
    };
  });
  return {
    id,
    details,
    schedule,
    notes: [
      ...recordNotes(id, details, state.expected),
      ...scheduleDifferences(state.schedule, schedule),
    ],
  };
}

/** What the read-back shows about the record itself: type, status, total, positions. */
function recordNotes(id: number, details: InvoiceDetails, expected: Amounts): string[] {
  const { invoice } = details;
  const notes: string[] = [];
  if (invoice.type.code !== "WKR") {
    notes.push(
      `sevDesk stored invoice ${String(id)} with another type than WKR (see invoice.type), so ` +
        "it may not be a recurring template at all. Check it in sevDesk.",
    );
  }
  if (invoice.status.code !== TEMPLATE_SAVE_STATUS) {
    notes.push(
      `sevDesk stored the template with status ${String(invoice.status.code)} instead of ` +
        `${String(TEMPLATE_SAVE_STATUS)}. Check it in sevDesk.`,
    );
  }
  const gross = invoice.totals.gross?.amount;
  if (gross !== undefined && compare(gross, expected.gross) !== 0) {
    notes.push(
      `sevDesk computed a gross total of ${gross} ${invoice.currency} per invoice; the preview ` +
        `expected ${expected.gross} ${invoice.currency}. Check the template's positions and ` +
        "price mode in sevDesk before its first run: every invoice carries them.",
    );
  }
  if (!details.positionsComplete) {
    notes.push("sevDesk has more positions than could be read back; positions is partial.");
  }
  return notes;
}

/**
 * The id of the saved template. An answer without one means sevDesk saved something that cannot
 * be read back: the message says a template may exist and how to find it, so the call is not
 * repeated blindly (a second template would bill the customer twice).
 */
function savedTemplateId(response: unknown): number {
  try {
    return savedDocumentId(response, "invoice", "recurring invoice template");
  } catch (error) {
    if (!(error instanceof SevdeskError) || error.kind !== "unexpected_response") throw error;
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        "sevDesk accepted the request, but its answer did not contain the template's id, so it " +
        "could not be read back. A recurring invoice template may exist now: look for it with " +
        "sevdesk_invoices_list (type recurring) or in sevDesk under Abo-Rechnungen, and delete " +
        "or deactivate it there before repeating the call.",
      cause: error,
    });
  }
}
