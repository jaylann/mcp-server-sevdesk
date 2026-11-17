/**
 * Changing a stored recurring invoice template (Abo-Rechnung, type WKR): its content (positions,
 * texts, payment term, tax rule, customer, address), its schedule (interval, start, end) and its
 * automatic generation.
 *
 * What sevDesk does with an update (recorded 2026-11-17, spec/deviations.md D-111, D-112, D-132):
 * - `saveInvoice` with the template's id and only the fields that change keeps everything else
 *   (type, status, contact, texts, schedule, positions, settings). So the body is minimal: it
 *   never carries `invoiceType` or `status` (`changeTemplateBodySchema`).
 * - A new `accountIntervall` alone moves neither the start nor the next run; `accountEndDate` is
 *   stored alone, and `null` removes it.
 * - A new `accountStartDate` moves start and next run to it and clears `accountLastInvoice`, also
 *   on a template that has run; with a start that was due, sevDesk billed a period a second time.
 *   So whether a template has run is read from the invoices that name it as `origin`, and a new
 *   start must lie after today and after the last day of the newest period billed.
 * - `propertyAutoGenerateRecurringInvoice: true` switches automatic generation on, `false` off.
 *   With generation on and a next run before today, sevDesk catches up one draft per missed
 *   period, a minute apart: switching it on then is refused unless the same call sets a new start,
 *   and so is removing or moving an end date that lies before such a run (`checkEndKeepsPastRun`).
 * - The price of a position sent by its id is kept (D-135). Positions are therefore replaced as a
 *   whole, like the invoice draft update does it, and the read-back compares the stored positions
 *   with the ones sent, so a change sevDesk ignored becomes a note.
 *
 * A template with automatic sending on, or whose settings sevDesk does not return, is not changed
 * here (`assertNoAutoSending`): sevDesk would e-mail invoices from it with no further approval.
 * Content goes through the same resolvers and checks as the invoice draft update
 * (`resolveUpdateBasics`); the schedule through the rules of a new template (`schedule.ts`).
 */
import { z } from "zod";

import { canonicalJson, sha256Hex } from "../../safety/hashing.js";
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
import { getInvoice, type InvoiceDetails, readTemplateSchedule } from "../invoices.js";
import { compare, decimal, format } from "../money.js";
import { type ChangeTemplateBody, changeTemplateBodySchema } from "./payload.js";
import {
  checkEndDate,
  checkStartDate,
  INTERVALS,
  RECURRING_INTERVALS,
  type RecurringInterval,
  scheduleFrom,
  settingsDifferences,
  type StoredSchedule,
} from "./schedule.js";
import {
  assertNoAutoSending,
  assertTemplate,
  type ExpectedSchedule,
  lastBilledDay,
  sameTemplateSaved,
  scheduleNotes,
  templateIdInput,
  templateRecordNotes,
  type TemplateState,
  templateState,
} from "./template.js";
import {
  type ChangeName,
  type GenerationChange,
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
      "New first run, YYYY-MM-DD: after today, at most a year ahead, on day 1–28, and after the " +
        "period of the newest invoice the template generated. It also becomes the next run, and " +
        "sevDesk clears the stored last run.",
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
  autoGenerate: z
    .boolean()
    .optional()
    .describe(
      "Automatische Generierung: true makes sevDesk create a draft invoice from the template on " +
        "every run date by itself, false stops that. Switching it on is refused while the next " +
        "run lies before today (sevDesk would catch up every missed period) unless startDate is " +
        "given too.",
    ),
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
  readonly autoGenerate?: boolean | undefined;
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
  /** Automatic generation as switched by the call; `undefined` when the call leaves it alone. */
  readonly generationOn: boolean | undefined;
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
 * A new start date: after today, within the rules of a new template, and after the last day of
 * the newest period the template billed (read only when a start is given). Returns whether it
 * changes the stored start or next run.
 */
async function checkNewStart(
  client: SevdeskClient,
  args: RecurringInvoiceUpdateArgs & { readonly startDate: string },
  stored: StoredSchedule,
  today: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const { startDate } = args;
  if (startDate <= today) {
    refuse(
      `The new start date ${startDate} is not after today (${today} in Berlin). A start that is ` +
        "due makes sevDesk run the template at once, and for a template that has run it would " +
        "bill a period again. Give a later date.",
    );
  }
  checkStartDate(startDate, today);
  const billed = await lastBilledDay(client, args.id, signal);
  if (billed !== undefined && startDate <= billed) {
    refuse(
      `Recurring invoice template ${String(args.id)} has already billed the period up to ` +
        `${billed}, so the new start date ${startDate} would make sevDesk bill that period ` +
        `again. Give a start after ${billed}.`,
    );
  }
  return startDate !== stored.startDate || startDate !== stored.nextRun;
}

/** The end date after the call, checked against the run it follows. */
function resolveEnd(
  args: RecurringInvoiceUpdateArgs,
  stored: StoredSchedule,
  start: { readonly changed: boolean; readonly nextRun: string | undefined },
  today: string,
): string | undefined {
  if (args.removeEndDate === true) return undefined;
  const { nextRun } = start;
  if (args.endDate !== undefined) {
    if (start.changed && nextRun !== undefined) {
      checkEndDate(args.endDate, nextRun, "the start date");
    } else if (nextRun !== undefined && nextRun >= today) {
      checkEndDate(args.endDate, nextRun, "the next run");
    } else {
      checkEndDate(args.endDate, today, "today");
    }
    return args.endDate;
  }
  if (start.changed && nextRun !== undefined && stored.endDate !== undefined) {
    // The stored end must still follow the new start.
    checkEndDate(stored.endDate, nextRun, "the start date");
  }
  return stored.endDate;
}

/** The schedule after the call. Throws `validation` errors for dates outside the rules. */
async function resolveSchedule(
  client: SevdeskClient,
  args: RecurringInvoiceUpdateArgs,
  stored: StoredSchedule,
  today: string,
  signal: AbortSignal | undefined,
): Promise<ScheduleChange> {
  if (args.endDate !== undefined && args.removeEndDate === true) {
    refuse("Give either endDate or removeEndDate, not both.");
  }
  const interval = args.interval ?? stored.intervalKey;
  const intervalChanged =
    args.interval !== undefined && stored.interval !== INTERVALS[args.interval].wire;
  const { startDate: newStart } = args;
  const startChanged =
    newStart !== undefined &&
    (await checkNewStart(client, { ...args, startDate: newStart }, stored, today, signal));
  const startDate = startChanged ? newStart : stored.startDate;
  const nextRun = startChanged ? newStart : stored.nextRun;
  const endDate = resolveEnd(args, stored, { changed: startChanged, nextRun }, today);
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
 * Automatic generation after the call. Switching it on is refused without a next run, and while
 * the next run lies before today: sevDesk would catch up one draft per missed period.
 */
function resolveGeneration(
  args: RecurringInvoiceUpdateArgs,
  stored: StoredSchedule,
  schedule: ScheduleChange,
  today: string,
): GenerationChange {
  const before = stored.autoGenerate;
  if (args.autoGenerate === undefined) return { before, after: before, changed: false };
  const after = args.autoGenerate ? "on" : "off";
  const changed = after !== before;
  if (changed && after === "on") {
    const { nextRun } = schedule;
    if (nextRun === undefined) {
      refuse(
        `Recurring invoice template ${String(args.id)} has no next run date, so when sevDesk ` +
          "would generate the first invoice cannot be shown. Give startDate together with " +
          "autoGenerate.",
      );
    }
    if (nextRun < today) {
      refuse(
        `The next run of recurring invoice template ${String(args.id)} is ${nextRun}, before ` +
          `today (${today} in Berlin). With automatic generation on, sevDesk would catch up and ` +
          "create a draft for every period since then, one a minute. Give a new startDate in " +
          "the same call.",
      );
    }
  }
  return { before, after, changed };
}

/**
 * Refuses an end date change that lets a past next run happen: an active template whose automatic
 * generation is on after the call (or has a stored value whose meaning is not recorded) and whose
 * next run lies before today and after its stored end date, which the call removes or moves past
 * that run. sevDesk could then catch up one draft per missed period, a minute apart, as it does for
 * a start in the past (D-111), and no preview shows those drafts. What sevDesk does on reaching an
 * end date is not recorded: the refusal rests only on that catch-up, the same one that refuses
 * switching generation on (`resolveGeneration`) and reactivating (`status.ts`) with a past next
 * run. A new start in the same call moves the next run after today and passes.
 */
function checkEndKeepsPastRun(
  id: number,
  state: TemplateState,
  stored: StoredSchedule,
  schedule: ScheduleChange,
  generation: GenerationChange,
  today: string,
): void {
  const { nextRun } = schedule;
  if (state !== "active" || generation.after === "off") return;
  if (nextRun === undefined || nextRun >= today || stored.endDate === undefined) return;
  const blocks = (end: string | undefined): boolean => end !== undefined && end < nextRun;
  if (!blocks(stored.endDate) || blocks(schedule.endDate)) return;
  const switchState =
    generation.after === "on"
      ? "with automatic generation on"
      : "with automatic generation stored as a value whose meaning is not recorded";
  refuse(
    `The next run of recurring invoice template ${String(id)} is ${nextRun}: before today ` +
      `(${today} in Berlin) and after its end date ${stored.endDate}, ${switchState}. With the ` +
      "end date removed or moved past that run, sevDesk could catch up and create a draft for " +
      "every period since then, one a minute, as it does for a start in the past; no preview " +
      "shows those drafts. Give a new startDate in the same call.",
  );
}

/**
 * Validates a change (the template and its settings first, then the schedule), reads what the
 * body needs, and builds the minimal body and both previews. Throws `validation` errors for a call
 * that is not about a template, is not safe, or changes nothing; sends nothing.
 */
export async function prepareRecurringInvoiceUpdate(
  client: SevdeskClient,
  args: RecurringInvoiceUpdateArgs,
  options: DraftCallOptions,
): Promise<RecurringInvoiceUpdatePlan> {
  const { signal } = options;
  assertChanges(args, "recurring invoice template");
  const current = await loadCurrentInvoice(client, args.id, signal);
  const doc = current.document;
  assertTemplate(
    args.id,
    doc.invoiceType,
    TOOL,
    "A draft invoice is changed with sevdesk_invoice_update_draft.",
  );
  const state = templateState(doc.id, doc.status);
  const stored = await readTemplateSchedule(client, doc.id, signal);
  assertNoAutoSending(doc.id, stored, "changed");
  const today = todayInBerlin();
  const schedule = await resolveSchedule(client, args, stored, today, signal);
  const generation = resolveGeneration(args, stored, schedule, today);
  checkEndKeepsPastRun(doc.id, state, stored, schedule, generation, today);

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
        // true reads back "1", false reads back "" (D-132).
        propertyAutoGenerateRecurringInvoice: generation.changed
          ? generation.after === "on"
          : undefined,
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

  const changed = changeNames(body, schedule, generation);
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
    generation,
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
      generationOn: generation.changed ? generation.after === "on" : undefined,
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
function changeNames(
  body: ChangeTemplateBody,
  schedule: ScheduleChange,
  generation: GenerationChange,
): ChangeName[] {
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
    ["automatic generation", generation.changed],
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
 * with its positions, schedule and settings (`getInvoice`). A failing read-back names the
 * template as a completed write.
 */
export async function executeRecurringInvoiceUpdate(
  client: SevdeskClient,
  state: RecurringInvoiceUpdateState,
  options: CountryReadOptions,
): Promise<RecurringInvoiceUpdateResult> {
  const { signal } = options;
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
  const details = await readBack(saved, () => getInvoice(client, id, options));
  const schedule = details.invoice.schedule ?? {};
  // The schedule of a record that is no template any more is not read; its type note says so.
  const isTemplate = details.invoice.type.code === "WKR";
  return {
    id,
    details,
    schedule,
    notes: [
      ...templateRecordNotes(id, details.invoice, state.status),
      ...(isTemplate ? scheduleNotes(state.schedule, schedule) : []),
      ...(isTemplate && state.generationOn !== undefined
        ? settingsDifferences(state.generationOn, schedule)
        : []),
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
