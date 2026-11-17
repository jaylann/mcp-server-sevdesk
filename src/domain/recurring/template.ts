/**
 * What the tools that change a stored recurring invoice template (Abo-Rechnung, type WKR) share:
 * the id argument, reading the template with its schedule, the checks that it is a template and
 * which state it is in, and the reading back after a save.
 *
 * A template is active at status 100 or 200 and ended at 50 (spec/deviations.md D-112). sevDesk
 * keeps every schedule field when a template is ended (recorded 2026-11-17), so an ended
 * template's `nextRun` is a date it kept, not a run that will happen.
 */
import { z } from "zod";

import { expectArray } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { toSevdeskId } from "../../sevdesk/paths.js";
import { parseUpstream, zBerlinDate, zOptionalInt, zOptionalRef } from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import type { CountryReadOptions } from "../country-codes.js";
import { savedDocumentId } from "../drafts/payloads.js";
import { getInvoice, type InvoiceDetail, type InvoiceDetails } from "../invoices.js";
import { type Phrase, phrase, type PreviewLanguage } from "../preview-text.js";
import { documentTypeByCode } from "../reference-data.js";
import { RUN_DATE_BEHAVIOUR, RUN_DATE_ON_AT_STORED_TIME } from "./run-date.js";
import { ENDED_STATUS, type StoredSchedule } from "./schedule.js";

/** The statuses of an active template: 100, the status of a new one, and 200 (D-112). */
const ACTIVE_STATUSES: ReadonlySet<number> = new Set([100, 200]);

/** The `id` argument of the template tools. */
export const templateIdInput = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .describe(
    "Id of the recurring invoice template (Abo-Rechnung, type WKR; not a number, templates have " +
      "none), e.g. from sevdesk_invoices_list with type recurring.",
  );

/** Whether a template creates invoices (`active`) or not (`ended`, status 50). */
export type TemplateState = "active" | "ended";

function refuse(message: string): never {
  throw new SevdeskError({ kind: "validation", message });
}

/**
 * Refuses an invoice that is not a recurring template. The type is upstream text: only its
 * reference-data label is named, never the code as sent. `instead` (trusted) names the tool for
 * what the invoice is.
 */
export function assertTemplate(
  id: number,
  invoiceType: string | undefined,
  tool: string,
  instead: string,
): void {
  const code = invoiceType?.trim().toUpperCase() ?? "RE";
  if (code === "WKR") return;
  const known = documentTypeByCode("invoice", code);
  const what =
    known === undefined
      ? "not a recurring invoice template"
      : `a ${known.label.toLowerCase()} (${known.code}), not a recurring invoice template`;
  refuse(
    `Invoice ${String(id)} is ${what}; ${tool} works only on recurring invoice templates (WKR, ` +
      `Abo-Rechnung). ${instead}`,
  );
}

/** The state of a template at `status`; any other status is refused (not known for templates). */
export function templateState(id: number, status: number): TemplateState {
  if (ACTIVE_STATUSES.has(status)) return "active";
  if (status === ENDED_STATUS) return "ended";
  return refuse(
    `Recurring invoice template ${String(id)} has status ${String(status)}, which this server ` +
      "does not know for templates (100 or 200 active, 50 ended). Check it in sevDesk.",
  );
}

/** One stored template as the status tools and every read-back see it. */
export interface StoredTemplate {
  readonly details: InvoiceDetails;
  /** The schedule with automatic generation and sending (`{}` when the invoice is no template). */
  readonly schedule: StoredSchedule;
}

/**
 * The invoice with its positions and, for a template, its schedule and settings
 * (`getInvoice`). A missing invoice is a `validation` error that says how to find templates.
 */
export async function loadTemplate(
  client: SevdeskClient,
  id: number,
  options: CountryReadOptions,
): Promise<StoredTemplate> {
  try {
    return templateOf(await getInvoice(client, id, options));
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") {
      refuse(
        `Invoice ${String(id)} does not exist in sevDesk. Find recurring invoice templates with ` +
          "sevdesk_invoices_list (type recurring).",
      );
    }
    throw error;
  }
}

/** A read invoice as a {@link StoredTemplate}. */
export function templateOf(details: InvoiceDetails): StoredTemplate {
  return { details, schedule: details.invoice.schedule ?? {} };
}

/**
 * Refuses to change or reactivate a template whose automatic sending is on, or whose settings
 * sevDesk did not return (D-132). With sending on, sevDesk finalizes, e-mails and enshrines every
 * invoice it generates, with no approval of this server's `external` tier: a change or a restart
 * here would let that happen. Ending stays allowed, since it stops the e-mails.
 */
export function assertNoAutoSending(
  id: number,
  schedule: StoredSchedule,
  done: "changed" | "reactivated",
): void {
  if (schedule.autoSendConfigured === true) {
    refuse(
      `Recurring invoice template ${String(id)} has automatic sending (Automatisches Versenden) ` +
        "on: sevDesk would finalize, e-mail and enshrine every invoice it creates from it, with " +
        `no further approval. Such a template is ${done} in the sevDesk web app; ` +
        "sevdesk_invoice_end_recurring ends it here, which stops the e-mails.",
    );
  }
  if (schedule.autoSendConfigured === undefined || schedule.autoGenerate === undefined) {
    refuse(
      `sevDesk did not return the automatic generation and sending settings of recurring invoice ` +
        `template ${String(id)}, so whether it would e-mail invoices by itself could not be ` +
        `checked. It is not ${done} here; check it in the sevDesk web app.`,
    );
  }
}

/** Automatic generation as stored, in words (D-132). */
const GENERATION_TEXT: Readonly<Record<"on" | "off" | "unrecorded" | "unread", Phrase>> = {
  on: phrase("on", "an"),
  off: phrase("off (never set or switched off)", "aus (nie gesetzt oder ausgeschaltet)"),
  unrecorded: phrase(
    "a stored value whose meaning is not recorded",
    "ein gespeicherter Wert, dessen Bedeutung nicht erfasst ist",
  ),
  unread: phrase("not returned by sevDesk", "von sevDesk nicht geliefert"),
};

/** A template's automatic generation in words, for a preview. */
export function generationText(
  state: StoredSchedule["autoGenerate"],
  lang: PreviewLanguage,
): string {
  return GENERATION_TEXT[state ?? "unread"][lang];
}

/**
 * What sevDesk does on a run date with automatic generation on, for a stored template: the
 * sentence of `run-date.ts` that names 00:00 only when the stored next run is at midnight.
 */
export function generationOnPhrase(schedule: StoredSchedule): Phrase {
  return schedule.runTime === undefined ? RUN_DATE_BEHAVIOUR.on : RUN_DATE_ON_AT_STORED_TIME;
}

/** Invoices sevDesk generated from a template that are read to find the newest period. */
const GENERATED_SCAN_LIMIT = 1000;

const generatedRowSchema = z.object({
  id: zOptionalInt,
  origin: zOptionalRef,
  deliveryDate: zBerlinDate,
  deliveryDateUntil: zBerlinDate,
});

/**
 * The last day of the newest period template `id` has billed: the latest `deliveryDateUntil` (or
 * `deliveryDate`) of the invoices that name it as `origin`, listed with
 * `GET /Invoice?origin[id]=…&origin[objectName]=Invoice&showAll=true`, which returned exactly the
 * template's generated invoices (D-111). Each row's origin is re-checked here all the same, as a
 * defence against a filter sevDesk ignores silently (D-015). `undefined` when it has generated
 * none. `validation` errors, since the newest period could be missed: more rows than one read
 * takes, and a generated invoice with neither date (each carries both, D-111), whose period cannot
 * be told.
 */
export async function lastBilledDay(
  client: SevdeskClient,
  id: number,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const payload = await client.request({
    method: "GET",
    path: "/Invoice",
    query: {
      "origin[id]": toSevdeskId(id),
      "origin[objectName]": "Invoice",
      showAll: true,
      limit: GENERATED_SCAN_LIMIT,
      offset: 0,
    },
    ...(signal === undefined ? {} : { signal }),
  });
  const rows = expectArray(payload, "invoices");
  if (rows.length >= GENERATED_SCAN_LIMIT) {
    refuse(
      `Recurring invoice template ${String(id)} has generated ${String(GENERATED_SCAN_LIMIT)} ` +
        "invoices or more, so the newest billed period could not be checked. Change its start " +
        "date in the sevDesk web app.",
    );
  }
  let last: string | undefined;
  for (const raw of rows) {
    const row = parseUpstream(generatedRowSchema, raw, "an invoice generated from a template");
    if (row.origin?.id !== id || row.origin.objectName !== "Invoice") continue;
    const end = row.deliveryDateUntil ?? row.deliveryDate;
    if (end === undefined) {
      const invoice = row.id === undefined ? "An invoice" : `Invoice ${String(row.id)}`;
      refuse(
        `${invoice} generated from recurring invoice template ${String(id)} has no delivery ` +
          "date (Lieferdatum or Leistungszeitraum), so the newest period the template has billed " +
          "cannot be told, and a new start date could bill a period again. Check that invoice in " +
          "sevDesk, or change the template's start date in the sevDesk web app.",
      );
    }
    if (last === undefined || end > last) last = end;
  }
  return last;
}

/**
 * The id a save of template `id` answered with. Another id means sevDesk saved something else
 * than the template: a completed write the caller has to look at, never repeated blindly.
 */
export function sameTemplateSaved(response: unknown, id: number): number {
  const saved = savedDocumentId(response, "invoice", "recurring invoice template");
  if (saved !== id) {
    throw new SevdeskError({
      kind: "unexpected_response",
      message:
        `sevDesk saved invoice ${String(saved)} instead of changing recurring invoice template ` +
        `${String(id)}. Check both in sevDesk (Abo-Rechnungen) before repeating the call.`,
      completedWrites: [{ objectName: "Invoice", id: String(saved) }],
    });
  }
  return saved;
}

/** Trusted notes on a template read back after a save: type and status. */
export function templateRecordNotes(
  id: number,
  invoice: InvoiceDetail,
  expectedStatus: number,
): string[] {
  const notes: string[] = [];
  if (invoice.type.code !== "WKR") {
    notes.push(
      `sevDesk now stores invoice ${String(id)} with another type than WKR (see invoice.type), ` +
        "so it may no longer be a recurring template. Check it in sevDesk.",
    );
  }
  if (invoice.status.code !== expectedStatus) {
    notes.push(
      `sevDesk stored the template with status ${String(invoice.status.code)} instead of ` +
        `${String(expectedStatus)}. Check it in sevDesk.`,
    );
  }
  return notes;
}

/** A schedule as it should read back after a save (dates `YYYY-MM-DD`). */
export interface ExpectedSchedule {
  /** `accountIntervall` as it should be stored (the form sent, or the stored one kept). */
  readonly interval: string | undefined;
  readonly startDate: string | undefined;
  readonly nextRun: string | undefined;
  readonly endDate: string | undefined;
}

/**
 * Trusted notes on every way the stored schedule differs from the expected one. Stored values are
 * dates parsed into `YYYY-MM-DD`; the stored interval is upstream text and is not repeated here
 * (the output carries it).
 */
export function scheduleNotes(expected: ExpectedSchedule, stored: StoredSchedule): string[] {
  const notes: string[] = [];
  const none = "none";
  if (stored.interval !== expected.interval) {
    notes.push(
      "sevDesk stored another interval than expected (see schedule.interval). Check the " +
        "template in sevDesk.",
    );
  }
  const dates = [
    ["start date", stored.startDate, expected.startDate],
    ["next run", stored.nextRun, expected.nextRun],
    ["end date", stored.endDate, expected.endDate],
  ] as const;
  for (const [label, actual, wanted] of dates) {
    if (actual !== wanted) {
      notes.push(
        `sevDesk stored the ${label} ${actual ?? none} instead of ${wanted ?? none}. Check the ` +
          "template in sevDesk before its next run.",
      );
    }
  }
  return notes;
}
