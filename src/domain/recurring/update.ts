/**
 * Changing a stored recurring invoice template (Abo-Rechnung, type WKR): its content (positions,
 * texts, payment term, tax rule, customer, address) and its schedule (interval, start, end).
 *
 * What sevDesk does with an update (recorded 2026-11-17, spec/deviations.md D-111, D-112):
 * - `saveInvoice` with the template's id and only the fields that change keeps everything else
 *   (type, status, contact, texts, schedule, positions). So the body is minimal: it never carries
 *   `invoiceType` or `status` (`changeTemplateBodySchema`).
 * - A new `accountIntervall` alone moves neither the start nor the next run; a new
 *   `accountStartDate` moves both (on a template that has not run yet; a template that has run is
 *   not recorded, so a new start is refused there); `accountEndDate` is stored alone, and `null`
 *   removes it.
 * - A position sent by its id with only a new price was left unchanged without an error. Positions
 *   are therefore replaced as a whole, like the invoice draft update does it, and the read-back
 *   compares the stored positions with the ones sent, so a change sevDesk ignored becomes a note.
 *
 * Content goes through the same resolvers and checks as the invoice draft update
 * (`resolveUpdateBasics`: tax rule and rates against the account, units, contact, address); the
 * schedule through the rules of a new template (`schedule.ts`).
 */
import { z } from "zod";

import { canonicalJson, sha256Hex } from "../../safety/hashing.js";
import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { cleanText, isoDateInput } from "../common.js";
import type { CountryReadOptions } from "../country-codes.js";
import { type PositionDto, TEXT_MAX } from "../document-positions.js";
import { loadCurrentInvoice } from "../drafts/current.js";
import { assertChanges, ref, structuredAddress } from "../drafts/document.js";
import { todayInBerlin, wireTimestamp } from "../drafts/fields.js";
import {
  INVOICE_TAX_OPTIONS,
  invoiceStoredAddress,
  invoiceUpdateInputShape,
} from "../drafts/invoice.js";
import { strictBody } from "../drafts/payloads.js";
import {
  type Amounts,
  type DraftPosition,
  expectedTotals,
  positionPayload,
  type PriceMode,
} from "../drafts/positions.js";
import type { DraftPreview } from "../drafts/preview.js";
import { readBack } from "../drafts/read-back.js";
import { addressInputShape } from "../drafts/recipient.js";
import {
  addressBlock,
  type DraftCallOptions,
  resolveUpdateBasics,
  type UpdateArgs,
} from "../drafts/shared.js";
import { getInvoice, type InvoiceDetails } from "../invoices.js";
import { compare, decimal, format } from "../money.js";
import { type ChangeTemplateBody, changeTemplateBodySchema } from "./payload.js";
import {
  checkEndDate,
  checkStartDate,
  INTERVALS,
  readStoredSchedule,
  RECURRING_INTERVALS,
  type RecurringInterval,
  scheduleFrom,
  type StoredSchedule,
} from "./schedule.js";
import {
  assertTemplate,
  type ExpectedSchedule,
  readTemplateRecord,
  sameTemplateSaved,
  scheduleNotes,
  templateIdInput,
  templateRecordNotes,
  templateState,
} from "./template.js";
import {
  type ChangeName,
  type ScheduleChange,
  type TemplateUpdatePreviewInput,
  templateUpdatePreviews,
} from "./update-preview.js";

const SAVE_PATH = "/Invoice/Factory/saveInvoice";
const TOOL = "sevdesk_invoice_update_recurring";

/** Input fields of `sevdesk_invoice_update_recurring` (without `dryRun`). */
export const recurringInvoiceUpdateInputShape = {
  id: templateIdInput,
  interval: z
    .enum(RECURRING_INTERVALS)
    .optional()
    .describe(
      "New interval: monthly, quarterly, half_yearly or yearly. The next run date stays; the " +
        "runs after it follow the new interval.",
    ),
  startDate: isoDateInput
    .optional()
    .describe(
      "New first run, YYYY-MM-DD (today or later, at most a year ahead, day 1–28); it also " +
        "becomes the next run. Only for a template that has not created an invoice yet.",
    ),
  endDate: isoDateInput
    .optional()
    .describe(
      "New end date (Enddatum), YYYY-MM-DD: on or after the next run, at most 10 years after it.",
    ),
  removeEndDate: z
    .literal(true)
    .optional()
    .describe("true removes the end date: the template runs until it is ended."),
  positions: invoiceUpdateInputShape.positions.describe(
    "When given, replaces ALL positions of every later invoice; leave out to keep them.",
  ),
  contactId: invoiceUpdateInputShape.contactId.describe(
    "Bill another customer from now on; takes that contact's invoice address unless you give one.",
  ),
  timeToPay: invoiceUpdateInputShape.timeToPay,
  priceMode: invoiceUpdateInputShape.priceMode,
  taxRuleId: invoiceUpdateInputShape.taxRuleId,
  taxText: invoiceUpdateInputShape.taxText,
  header: invoiceUpdateInputShape.header.describe("New title (Betreff) of every later invoice."),
  headText: invoiceUpdateInputShape.headText,
  footText: invoiceUpdateInputShape.footText,
  contactPersonId: invoiceUpdateInputShape.contactPersonId,
  ...addressInputShape,
};

export interface RecurringInvoiceUpdateArgs extends UpdateArgs {
  readonly id: number;
  readonly interval?: RecurringInterval | undefined;
  readonly startDate?: string | undefined;
  readonly endDate?: string | undefined;
  readonly removeEndDate?: true | undefined;
  readonly timeToPay?: number | undefined;
  readonly header?: string | undefined;
  readonly headText?: string | undefined;
  readonly footText?: string | undefined;
}

/** What `execute` needs: the exact body the preview describes, and what it promised. */
export interface RecurringInvoiceUpdateState {
  readonly id: number;
  readonly body: ChangeTemplateBody;
  /** The status the template keeps (the body sends none). */
  readonly status: number;
  readonly schedule: ExpectedSchedule;
  /** Set when the positions are replaced: what was sent, and the totals expected. */
  readonly positions?:
    | {
        readonly sent: readonly DraftPosition[];
        readonly mode: PriceMode;
        readonly expected: Amounts;
      }
    | undefined;
  /** The number of stored positions, which an update without positions keeps. */
  readonly keptPositions: number;
  /** What changes, for the summary (trusted names). */
  readonly changed: readonly ChangeName[];
}

export interface RecurringInvoiceUpdatePlan {
  readonly preview: DraftPreview;
  readonly previewDe: DraftPreview;
  /** SHA-256 of the body, so the approval covers exactly what is sent. */
  readonly binding: string;
  readonly state: RecurringInvoiceUpdateState;
}

function refuse(message: string): never {
  throw new SevdeskError({ kind: "validation", message });
}

/**
 * The schedule after the call. Throws `validation` errors for a start date on a template that has
 * run, and for start and end dates outside the rules of a new template.
 */
function resolveSchedule(
  args: RecurringInvoiceUpdateArgs,
  stored: StoredSchedule,
  today: string,
): ScheduleChange {
  if (args.endDate !== undefined && args.removeEndDate === true) {
    refuse("Give either endDate or removeEndDate, not both.");
  }
  const interval = args.interval ?? stored.intervalKey;
  const intervalChanged =
    args.interval !== undefined && stored.interval !== INTERVALS[args.interval].wire;

  let startChanged = false;
  if (args.startDate !== undefined) {
    if (stored.lastRun !== undefined) {
      refuse(
        `Recurring invoice template ${String(args.id)} created an invoice on ${stored.lastRun} ` +
          "already. What a new start date does to a template that has run is not recorded (it " +
          "could create past invoices again), so it is not changed here: change the start in " +
          "the sevDesk web app, or end this template and create a new one.",
      );
    }
    checkStartDate(args.startDate, today);
    startChanged = args.startDate !== stored.startDate || args.startDate !== stored.nextRun;
  }
  const startDate = startChanged ? args.startDate : stored.startDate;
  const nextRun = startChanged ? args.startDate : stored.nextRun;

  let endDate = stored.endDate;
  if (args.removeEndDate === true) {
    endDate = undefined;
  } else if (args.endDate !== undefined) {
    endDate = args.endDate;
    if (startChanged && args.startDate !== undefined) {
      checkEndDate(args.endDate, args.startDate, "the start date");
    } else if (nextRun !== undefined && nextRun >= today) {
      checkEndDate(args.endDate, nextRun, "the next run");
    } else {
      checkEndDate(args.endDate, today, "today");
    }
  } else if (startChanged && args.startDate !== undefined && stored.endDate !== undefined) {
    // The stored end must still follow the new start.
    checkEndDate(stored.endDate, args.startDate, "the start date");
  }
  return {
    interval,
    intervalChanged,
    startChanged,
    startDate,
    nextRun,
    endChanged: endDate !== stored.endDate,
    endDate,
  };
}

/**
 * Validates a change (schedule first, so a refused schedule costs only the template's read),
 * reads what the body needs, and builds the minimal body and both previews. Throws `validation`
 * errors for a call that is not about a template or changes nothing; sends nothing.
 */
export async function prepareRecurringInvoiceUpdate(
  client: SevdeskClient,
  args: RecurringInvoiceUpdateArgs,
  options: DraftCallOptions,
): Promise<RecurringInvoiceUpdatePlan> {
  assertChanges(args, "recurring invoice template");
  const current = await loadCurrentInvoice(client, args.id, options.signal);
  const doc = current.document;
  assertTemplate(
    args.id,
    doc.invoiceType,
    TOOL,
    "A draft invoice is changed with sevdesk_invoice_update_draft.",
  );
  const state = templateState(doc.id, doc.status);
  const stored = readStoredSchedule(current.record);
  const today = todayInBerlin();
  const schedule = resolveSchedule(args, stored, today);

  const basics = await resolveUpdateBasics(
    client,
    doc,
    invoiceStoredAddress(doc),
    current.positions,
    args,
    { scope: INVOICE_TAX_OPTIONS.scope },
    options,
  );
  const positions = basics.positions;
  const expected = positions === undefined ? undefined : expectedTotals(positions, basics.mode);
  if (expected !== undefined && compare(expected.gross, 0) <= 0) {
    refuse(
      `Every invoice of this template would total ${expected.gross} ${basics.currency} gross. A ` +
        "recurring invoice must charge something: check the positions (a credit to the customer " +
        "is a credit note, not a recurring invoice).",
    );
  }

  const header = changedText(args.header, doc.header);
  const headText = changedText(args.headText, doc.headText);
  const footText = changedText(args.footText, doc.footText);
  const timeToPay = args.timeToPay === doc.timeToPay ? undefined : args.timeToPay;

  const body = strictBody(
    changeTemplateBodySchema,
    {
      invoice: {
        id: doc.id,
        objectName: "Invoice",
        mapAll: true,
        contact: basics.contactChanged ? ref(basics.contact.contact.id, "Contact") : undefined,
        contactPerson: basics.contactPersonChanged
          ? ref(basics.contactPerson.id, "SevUser")
          : undefined,
        header,
        headText,
        footText,
        timeToPay,
        showNet: basics.modeChanged ? basics.mode === "net" : undefined,
        ...(basics.taxChanged ? basics.tax : {}),
        ...(basics.address === undefined
          ? {}
          : { address: addressBlock(basics.address), ...structuredAddress(basics.address) }),
        accountIntervall:
          schedule.intervalChanged && schedule.interval !== undefined
            ? INTERVALS[schedule.interval].wire
            : undefined,
        accountStartDate:
          schedule.startChanged && schedule.startDate !== undefined
            ? wireTimestamp(schedule.startDate)
            : undefined,
        // null removes the end date (an empty string is refused, recorded 2026-11-17).
        accountEndDate: !schedule.endChanged
          ? undefined
          : schedule.endDate === undefined
            ? null
            : wireTimestamp(schedule.endDate),
      },
      invoicePosSave:
        positions === undefined
          ? null
          : positions.map((position, index) => positionPayload(position, index, "InvoicePos")),
      invoicePosDelete:
        positions === undefined || current.positions.length === 0
          ? null
          : current.positions.map((row) => ref(row.id, "InvoicePos")),
    },
    "recurring invoice template change",
  );

  const changed = changeNames(body, schedule);
  if (changed.length === 0) {
    refuse(
      `Nothing changes: recurring invoice template ${String(doc.id)} already has every value ` +
        "given.",
    );
  }

  const projected =
    schedule.interval === undefined || schedule.nextRun === undefined
      ? undefined
      : scheduleFrom(schedule.interval, schedule.nextRun, schedule.endDate);
  const previewInput: TemplateUpdatePreviewInput = {
    id: doc.id,
    state,
    today,
    basics,
    storedContactId: doc.contact?.id,
    storedContactPersonId: doc.contactPerson?.id,
    storedMode: doc.showNet === false ? "gross" : "net",
    before: {
      header: cleanText(doc.header, 200),
      timeToPay: doc.timeToPay,
      positions: current.positions.length,
      gross: storedAmount(doc.sumGross),
    },
    after: { header, headText, footText, timeToPay, positions, expected },
    stored,
    schedule,
    projected,
  };
  const intervalWire = schedule.intervalChanged ? body.invoice.accountIntervall : stored.interval;

  return {
    ...templateUpdatePreviews(previewInput, changed),
    binding: sha256Hex(canonicalJson({ kind: "recurring-invoice-template-change", body })),
    state: {
      id: doc.id,
      body,
      status: doc.status,
      schedule: {
        interval: intervalWire,
        startDate: schedule.startDate,
        nextRun: schedule.nextRun,
        endDate: schedule.endDate,
      },
      positions:
        positions === undefined || expected === undefined
          ? undefined
          : { sent: positions, mode: basics.mode, expected },
      keptPositions: current.positions.length,
      changed,
    },
  };
}

/** A new text when it differs from the stored one, else `undefined` (nothing to send). */
function changedText(given: string | undefined, stored: string | undefined): string | undefined {
  return given === undefined || given === (stored ?? "") ? undefined : given;
}

/** A stored decimal sum with two decimals ("55" → "55.00"), or `undefined`. */
function storedAmount(value: string | undefined): string | undefined {
  return value === undefined ? undefined : format(decimal(value), 2);
}

/** The trusted names of what the body changes, in preview order. */
function changeNames(body: ChangeTemplateBody, schedule: ScheduleChange): ChangeName[] {
  const { invoice } = body;
  const names: [ChangeName, boolean][] = [
    ["customer", invoice.contact !== undefined],
    ["address", invoice.addressName !== undefined || invoice.address !== undefined],
    ["contact person", invoice.contactPerson !== undefined],
    ["title", invoice.header !== undefined],
    ["payment term", invoice.timeToPay !== undefined],
    ["price mode", invoice.showNet !== undefined],
    ["tax", invoice.taxRate !== undefined],
    ["head text", invoice.headText !== undefined],
    ["positions", body.invoicePosSave !== null],
    ["foot text", invoice.footText !== undefined],
    ["interval", schedule.intervalChanged],
    ["start date", schedule.startChanged],
    ["end date", schedule.endChanged],
  ];
  return names.filter(([, changed]) => changed).map(([name]) => name);
}

/** A changed template as read back, with trusted notes. */
export interface RecurringInvoiceUpdateResult {
  readonly id: number;
  readonly details: InvoiceDetails;
  readonly schedule: StoredSchedule;
  readonly notes: readonly string[];
}

/**
 * Sends the prepared body (one request, never retried) and reads the template back: the invoice
 * with its positions, and the raw record for the schedule. A failing read-back names the template
 * as a completed write.
 */
export async function executeRecurringInvoiceUpdate(
  client: SevdeskClient,
  state: RecurringInvoiceUpdateState,
  options: CountryReadOptions,
): Promise<RecurringInvoiceUpdateResult> {
  const { signal, cacheOwner } = options;
  const response = await client.request({
    method: "POST",
    path: SAVE_PATH,
    body: state.body,
    // A template save binds (PR #110 makes the client require it); the scoped client stamps the
    // tool's tier as well.
    tier: "commit",
    ...(signal === undefined ? {} : { signal }),
  });
  const id = sameTemplateSaved(response, state.id);
  const saved = { objectName: "Invoice", id: String(id) };
  const { details, schedule } = await readBack(saved, async () => {
    const [read, record] = await Promise.all([
      getInvoice(client, id, { signal, cacheOwner }),
      readTemplateRecord(client, id, signal),
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
      ...templateRecordNotes(id, details.invoice, state.status),
      ...scheduleNotes(state.schedule, schedule),
      ...positionNotes(state, details),
    ],
  };
}

/**
 * Trusted notes on the positions read back: their number, each one against what was sent (name,
 * quantity, unit price, tax rate), and the total. Stored names are upstream text and are not
 * repeated; only the position numbers and the field names are.
 */
function positionNotes(state: RecurringInvoiceUpdateState, details: InvoiceDetails): string[] {
  const notes: string[] = [];
  const stored = details.positions;
  if (!details.positionsComplete) {
    notes.push("sevDesk has more positions than could be read back; positions is partial.");
    return notes;
  }
  const sent = state.positions;
  if (sent === undefined) {
    if (stored.length !== state.keptPositions) {
      notes.push(
        `sevDesk now stores ${String(stored.length)} positions instead of the ` +
          `${String(state.keptPositions)} kept. Check the template's positions in sevDesk ` +
          "before its next run.",
      );
    }
    return notes;
  }
  if (stored.length !== sent.sent.length) {
    notes.push(
      `sevDesk stores ${String(stored.length)} positions; ${String(sent.sent.length)} were sent. ` +
        "Check the template's positions in sevDesk before its next run.",
    );
  } else {
    sent.sent.forEach((position, index) => {
      const row = stored[index];
      if (row === undefined) return;
      const differs = positionDifferences(position, row, sent.mode);
      if (differs.length > 0) {
        notes.push(
          `Position ${String(index + 1)} as stored differs from what was sent (` +
            `${differs.join(", ")}): sevDesk may have ignored the change. Check it in sevDesk ` +
            "before the template's next run.",
        );
      }
    });
  }
  const gross = details.invoice.totals.gross?.amount;
  if (gross !== undefined && compare(gross, sent.expected.gross) !== 0) {
    notes.push(
      `sevDesk computed a gross total of ${gross} ${details.invoice.currency} per invoice; the ` +
        `preview expected ${sent.expected.gross} ${details.invoice.currency}. Check the ` +
        "template's positions and price mode in sevDesk before its next run.",
    );
  }
  return notes;
}

/** Which of name, quantity, unit price and tax rate differ between a sent and a stored position. */
function positionDifferences(sent: DraftPosition, stored: PositionDto, mode: PriceMode): string[] {
  const price = mode === "net" ? stored.unitPriceNet : stored.unitPriceGross;
  const differs: [string, boolean][] = [
    ["name", cleanText(sent.name, TEXT_MAX.name) !== stored.name],
    ["quantity", !sameDecimal(sent.quantity, stored.quantity)],
    ["unit price", !sameDecimal(sent.unitPrice, price?.amount)],
    ["tax rate", !sameDecimal(sent.taxRate, stored.taxRate)],
  ];
  return differs.filter(([, differ]) => differ).map(([name]) => name);
}

function sameDecimal(sent: string, stored: string | undefined): boolean {
  return stored !== undefined && compare(sent, stored) === 0;
}
