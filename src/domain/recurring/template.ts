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

import { berlinDateOf } from "../../sevdesk/dates.js";
import { expectSingle } from "../../sevdesk/envelope.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import { sevdeskPath, toSevdeskId } from "../../sevdesk/paths.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { savedDocumentId } from "../drafts/payloads.js";
import { type InvoiceDetail, mapInvoiceDetail } from "../invoices.js";
import { documentTypeByCode } from "../reference-data.js";
import { ENDED_STATUS, readStoredSchedule, type StoredSchedule } from "./schedule.js";

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
  readonly invoice: InvoiceDetail;
  readonly schedule: StoredSchedule;
}

/**
 * `GET /Invoice/{id}?embed=contact`, mapped to the invoice DTO and the stored schedule. A missing
 * invoice is a `validation` error that says how to find templates.
 */
export async function loadTemplate(
  client: SevdeskClient,
  id: number,
  signal: AbortSignal | undefined,
): Promise<StoredTemplate> {
  let payload: unknown;
  try {
    payload = await readTemplateRecord(client, id, signal);
  } catch (error) {
    if (error instanceof SevdeskError && error.kind === "not_found") {
      refuse(
        `Invoice ${String(id)} does not exist in sevDesk. Find recurring invoice templates with ` +
          "sevdesk_invoices_list (type recurring).",
      );
    }
    throw error;
  }
  return storedTemplate(payload, id);
}

/** The raw record of a template, contact embedded (for its name). */
export function readTemplateRecord(
  client: SevdeskClient,
  id: number,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return client.request({
    method: "GET",
    path: sevdeskPath("Invoice", toSevdeskId(id)),
    query: { embed: "contact" },
    ...(signal === undefined ? {} : { signal }),
  });
}

/** Maps a `GET /Invoice/{id}` answer to {@link StoredTemplate}. */
export function storedTemplate(payload: unknown, id: number): StoredTemplate {
  const record = expectSingle(payload, `invoice ${String(id)}`);
  return {
    invoice: mapInvoiceDetail(record, berlinDateOf(Date.now())),
    schedule: readStoredSchedule(record),
  };
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
