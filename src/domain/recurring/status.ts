/**
 * Ending and reactivating a recurring invoice template (Abo-Rechnung, type WKR).
 *
 * Recorded (spec/deviations.md D-112; 2026-11-16 and 2026-11-17): `saveInvoice` with the template's
 * id and `status: "50"` ends it, `status: "100"` sets it back, and neither changes a schedule field
 * or a position. The body carries nothing else (`templateStatusBodySchema`), so the save cannot
 * change the template's content. Ending does not touch the invoices sevDesk already generated.
 *
 * Reactivating starts billing again, so its preview lists the next run dates and what sevDesk does
 * on a run date ({@link RUN_DATE_BEHAVIOUR}). It is refused when the kept next run is in the past:
 * sevDesk may then create every invoice due since that date at once, which no preview lists
 * (the same rule as a new template's start date). The template gets a new start date first.
 */
import { canonicalJson, sha256Hex } from "../../safety/hashing.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { cleanText, trimmedText } from "../common.js";
import { todayInBerlin } from "../drafts/fields.js";
import { strictBody } from "../drafts/payloads.js";
import type { DraftPreview, PreviewFact } from "../drafts/preview.js";
import { moneyText } from "../drafts/preview.js";
import { readBack } from "../drafts/read-back.js";
import {
  bothPreviews,
  dateText,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "../preview-text.js";
import { type TemplateStatusBody, templateStatusBodySchema } from "./payload.js";
import {
  endOnRunWarning,
  endText,
  followingRunsText,
  intervalText,
  SHORT_MONTH_RUNS,
} from "./preview.js";
import { RUN_DATE_BEHAVIOUR, TEMPLATE_SAVE_STATUS } from "./run-date.js";
import {
  ENDED_STATUS,
  runDayFitsEveryMonth,
  type Schedule,
  scheduleFrom,
  type StoredSchedule,
} from "./schedule.js";
import {
  assertTemplate,
  type ExpectedSchedule,
  loadTemplate,
  readTemplateRecord,
  sameTemplateSaved,
  scheduleNotes,
  type StoredTemplate,
  storedTemplate,
  templateRecordNotes,
  templateState,
} from "./template.js";

const SAVE_PATH = "/Invoice/Factory/saveInvoice";
const NAME_MAX = 200;

/** What a status tool does. */
export type TemplateStatusChange = "end" | "reactivate";

const TOOL: Readonly<Record<TemplateStatusChange, string>> = {
  end: "sevdesk_invoice_end_recurring",
  reactivate: "sevdesk_invoice_reactivate_recurring",
};

/** What `execute` needs: the exact body, and what the read-back should show. */
export interface TemplateStatusState {
  readonly change: TemplateStatusChange;
  readonly id: number;
  readonly body: TemplateStatusBody;
  readonly status: number;
  readonly schedule: ExpectedSchedule;
}

export interface TemplateStatusPlan {
  readonly preview: DraftPreview;
  readonly previewDe: DraftPreview;
  /** SHA-256 of the body, so the approval covers exactly what is sent. */
  readonly binding: string;
  readonly state: TemplateStatusState;
}

function refuse(message: string): never {
  throw new SevdeskError({ kind: "validation", message });
}

/**
 * Reads the template, checks that the change does something, and builds the body and both
 * previews. Throws `validation` errors; sends nothing.
 */
export async function prepareTemplateStatus(
  client: SevdeskClient,
  id: number,
  change: TemplateStatusChange,
  signal: AbortSignal | undefined,
): Promise<TemplateStatusPlan> {
  const template = await loadTemplate(client, id, signal);
  const { invoice, schedule } = template;
  assertTemplate(
    id,
    invoice.type.code,
    TOOL[change],
    "Find recurring invoice templates with sevdesk_invoices_list (type recurring).",
  );
  const state = templateState(id, invoice.status.code);
  const today = todayInBerlin();
  let projected: Schedule | undefined;
  if (change === "end") {
    if (state === "ended") {
      refuse(
        `Recurring invoice template ${String(id)} is ended already (status 50); nothing ` +
          "changes. sevdesk_invoice_reactivate_recurring starts it again.",
      );
    }
  } else {
    if (state === "active") {
      refuse(
        `Recurring invoice template ${String(id)} is active already (status ` +
          `${String(invoice.status.code)}); nothing changes. Change it with ` +
          "sevdesk_invoice_update_recurring or end it with sevdesk_invoice_end_recurring.",
      );
    }
    projected = checkReactivation(id, schedule, today);
  }

  const status = change === "end" ? ENDED_STATUS : TEMPLATE_SAVE_STATUS;
  const body = strictBody(
    templateStatusBodySchema,
    {
      invoice: { id, objectName: "Invoice", mapAll: true, status: String(status) },
      invoicePosSave: null,
      invoicePosDelete: null,
    },
    "recurring invoice template status",
  );
  const input: StatusPreviewInput = { id, template, projected, today };
  return {
    ...bothPreviews((lang) => ({
      action: change === "end" ? endAction(input, lang) : reactivateAction(input, lang),
      facts: change === "end" ? endFacts(input, lang) : reactivateFacts(input, lang),
      warnings: change === "end" ? endWarnings(input, lang) : reactivateWarnings(input, lang),
      irreversible: false,
    })),
    binding: sha256Hex(canonicalJson({ kind: `recurring-invoice-template-${change}`, body })),
    state: {
      change,
      id,
      body,
      status,
      // Recorded: neither status change moves a schedule field.
      schedule: {
        interval: schedule.interval,
        startDate: schedule.startDate,
        nextRun: schedule.nextRun,
        endDate: schedule.endDate,
      },
    },
  };
}

/**
 * The schedule a reactivated template follows from its kept next run, or a refusal when that run
 * is missing or past, when no run is left before the end date, or when the interval is not one
 * this server can list run dates for (the preview must show them).
 */
function checkReactivation(id: number, schedule: StoredSchedule, today: string): Schedule {
  const { nextRun, intervalKey, endDate } = schedule;
  const newStart =
    "Give it a new start date first with sevdesk_invoice_update_recurring (startDate), then " +
    "reactivate it.";
  if (nextRun === undefined) {
    refuse(
      `Recurring invoice template ${String(id)} has no next run date, so when sevDesk would ` +
        `create the next invoice cannot be shown. ${newStart}`,
    );
  }
  if (nextRun < today) {
    refuse(
      `The next run of recurring invoice template ${String(id)} is ${nextRun}, before today ` +
        `(${today} in Berlin). Reactivated, sevDesk may create every invoice due since then at ` +
        `once, which no preview shows. ${newStart}`,
    );
  }
  if (endDate !== undefined && endDate < nextRun) {
    refuse(
      `The end date ${endDate} of recurring invoice template ${String(id)} is before its next ` +
        `run ${nextRun}, so reactivating it would create no invoice. Give it a later endDate (or ` +
        "removeEndDate) with sevdesk_invoice_update_recurring first.",
    );
  }
  if (intervalKey === undefined) {
    refuse(
      `Recurring invoice template ${String(id)} has an interval this server does not offer (see ` +
        "schedule.interval in sevdesk_invoice_get), so its run dates cannot be shown. Set " +
        "interval with sevdesk_invoice_update_recurring first, or reactivate it in sevDesk.",
    );
  }
  return scheduleFrom(intervalKey, nextRun, endDate);
}

/** A status change as read back, with trusted notes. */
export interface TemplateStatusResult extends StoredTemplate {
  readonly id: number;
  readonly notes: readonly string[];
}

/** Sends the prepared body (one request, never retried) and reads the template back. */
export async function executeTemplateStatus(
  client: SevdeskClient,
  state: TemplateStatusState,
  signal: AbortSignal | undefined,
): Promise<TemplateStatusResult> {
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
  const template = await readBack(saved, async () =>
    storedTemplate(await readTemplateRecord(client, id, signal), id),
  );
  return {
    id,
    ...template,
    notes: [
      ...templateRecordNotes(id, template.invoice, state.status),
      ...scheduleNotes(state.schedule, template.schedule),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Previews (English and German from the same data, same facts and warnings in the same order)
// ---------------------------------------------------------------------------------------------

interface StatusPreviewInput {
  readonly id: number;
  readonly template: StoredTemplate;
  /** Reactivation: the runs from the kept next run on. */
  readonly projected: Schedule | undefined;
  readonly today: string;
}

const LABELS = {
  en: {
    template: "Template",
    customer: "Customer",
    title: "Title (Betreff)",
    interval: "Interval",
    nextRun: "Next run",
    followingRuns: "Following runs",
    end: "End",
    lastRun: "Last run",
    total: "Total per invoice",
    none: "none",
    noneYet: "none yet",
  },
  de: {
    template: "Vorlage",
    customer: "Kunde",
    title: "Betreff",
    interval: "Intervall",
    nextRun: "Nächste Ausführung",
    followingRuns: "Folgende Ausführungen",
    end: "Ende",
    lastRun: "Letzte Ausführung",
    total: "Summe je Rechnung",
    none: "keines",
    noneYet: "noch keine",
  },
} as const;

function customerText(input: StatusPreviewInput, lang: PreviewLanguage): string {
  const contact = input.template.invoice.contact;
  const word = lang === "de" ? "Kontakt" : "contact";
  if (contact === undefined) return lang === "de" ? "(kein Kontakt)" : "(no contact)";
  const name = cleanText(contact.name, NAME_MAX);
  const id = `${word} ${String(contact.id)}`;
  return name === undefined ? id : `${name} (${id})`;
}

function grossText(input: StatusPreviewInput, lang: PreviewLanguage): string | undefined {
  const gross = input.template.invoice.totals.gross;
  return gross === undefined ? undefined : moneyText(gross.amount, gross.currency, lang);
}

function totalText(input: StatusPreviewInput, lang: PreviewLanguage): string | undefined {
  const { net, tax, gross } = input.template.invoice.totals;
  if (gross === undefined) return undefined;
  const words = lang === "de" ? ["netto", "USt.", "brutto"] : ["net", "tax", "gross"];
  return [net, tax, gross]
    .map((money, index) =>
      money === undefined
        ? undefined
        : `${words[index] ?? ""} ${moneyText(money.amount, money.currency, lang)}`,
    )
    .filter((part): part is string => part !== undefined)
    .join(", ");
}

/** The stored interval as a preview names it: the offered interval, or the raw form. */
function storedIntervalText(schedule: StoredSchedule, lang: PreviewLanguage): string {
  const { interval, intervalKey, nextRun } = schedule;
  if (intervalKey !== undefined && nextRun !== undefined) {
    return intervalText(scheduleFrom(intervalKey, nextRun, undefined), lang);
  }
  if (interval === undefined) return lang === "de" ? "keines gespeichert" : "none stored";
  return lang === "de"
    ? `${interval} (kein Intervall, das dieser Server anbietet)`
    : `${interval} (not an interval this server offers)`;
}

function dateOrNone(date: string | undefined, none: string, lang: PreviewLanguage): string {
  return date === undefined ? none : dateText(date, lang);
}

function commonFacts(input: StatusPreviewInput, lang: PreviewLanguage): PreviewFact[] {
  const t = LABELS[lang];
  const { invoice, schedule } = input.template;
  const list: PreviewFact[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined && trimmedText(value) !== undefined) list.push({ label, value });
  };
  const status = invoice.status.code;
  add(
    t.template,
    lang === "de"
      ? `${String(input.id)} (Abo-Rechnung, Status ${String(status)})`
      : `${String(input.id)} (recurring invoice template, status ${String(status)})`,
  );
  add(t.customer, customerText(input, lang));
  add(t.title, invoice.header);
  add(t.interval, storedIntervalText(schedule, lang));
  return list;
}

function endAction(input: StatusPreviewInput, lang: PreviewLanguage): string {
  const customer = customerText(input, lang);
  return lang === "de"
    ? `Abo-Rechnung ${String(input.id)} für ${customer} beenden: sevDesk erzeugt aus ihr keine ` +
        "Rechnung mehr."
    : `End recurring invoice template ${String(input.id)} (Abo-Rechnung) for ${customer}: ` +
        "sevDesk creates no further invoice from it.";
}

function endFacts(input: StatusPreviewInput, lang: PreviewLanguage): PreviewFact[] {
  const t = LABELS[lang];
  const { schedule } = input.template;
  const next = schedule.nextRun;
  const facts = commonFacts(input, lang);
  facts.push({
    label: t.nextRun,
    value:
      next === undefined
        ? t.none
        : lang === "de"
          ? `${dateText(next, lang)}, entfällt mit dem Beenden`
          : `${next}, no longer happens once the template is ended`,
  });
  facts.push({ label: t.end, value: dateOrNone(schedule.endDate, t.none, lang) });
  facts.push({ label: t.lastRun, value: dateOrNone(schedule.lastRun, t.noneYet, lang) });
  const total = totalText(input, lang);
  if (total !== undefined) facts.push({ label: t.total, value: total });
  return facts;
}

const ENDING_KEEPS_INVOICES: Phrase = phrase(
  "Invoices sevDesk already created from this template stay as they are: ending it does not " +
    "cancel, change or delete any of them (a wrong one is cancelled with sevdesk_invoice_cancel).",
  "Rechnungen, die sevDesk aus dieser Vorlage schon erzeugt hat, bleiben, wie sie sind: Das " +
    "Beenden storniert, ändert oder löscht keine davon (eine falsche wird mit " +
    "sevdesk_invoice_cancel storniert).",
);

const ENDING_KEEPS_TEMPLATE: Phrase = phrase(
  "The template is kept with its positions and schedule: sevdesk_invoice_reactivate_recurring " +
    "starts it again. A template is deleted only in the sevDesk web app (Abo-Rechnungen).",
  "Die Vorlage bleibt mit ihren Positionen und ihrem Zeitplan erhalten: " +
    "sevdesk_invoice_reactivate_recurring startet sie wieder. Löschen lässt sich eine Vorlage nur " +
    "in der sevDesk-Web-App (Abo-Rechnungen).",
);

const RUN_TODAY_ENDING: Phrase = phrase(
  "The next run is today: if sevDesk has already created today's invoice, ending the template " +
    "does not undo it.",
  "Die nächste Ausführung ist heute: Hat sevDesk die heutige Rechnung schon erzeugt, macht das " +
    "Beenden sie nicht rückgängig.",
);

function endWarnings(input: StatusPreviewInput, lang: PreviewLanguage): string[] {
  return [
    ENDING_KEEPS_INVOICES[lang],
    ENDING_KEEPS_TEMPLATE[lang],
    ...(input.template.schedule.nextRun === input.today ? [RUN_TODAY_ENDING[lang]] : []),
  ];
}

function reactivateAction(input: StatusPreviewInput, lang: PreviewLanguage): string {
  const customer = customerText(input, lang);
  const gross = grossText(input, lang);
  const next = input.projected === undefined ? "" : dateText(input.projected.startDate, lang);
  if (lang === "de") {
    return (
      `Abo-Rechnung ${String(input.id)} für ${customer} wieder aktivieren: sevDesk erzeugt aus ` +
      `ihr wieder Rechnungen${gross === undefined ? "" : ` über ${gross} brutto`}, die nächste ` +
      `am ${next}.`
    );
  }
  return (
    `Reactivate recurring invoice template ${String(input.id)} (Abo-Rechnung) for ${customer}: ` +
    `sevDesk issues invoices from it again${gross === undefined ? "" : `, ${gross} gross each`}, ` +
    `the next on ${next}.`
  );
}

function reactivateFacts(input: StatusPreviewInput, lang: PreviewLanguage): PreviewFact[] {
  const t = LABELS[lang];
  const facts = commonFacts(input, lang);
  const { projected } = input;
  if (projected !== undefined) {
    facts.push({ label: t.nextRun, value: dateText(projected.startDate, lang) });
    facts.push({ label: t.followingRuns, value: followingRunsText(projected, lang) });
    facts.push({ label: t.end, value: endText(projected, lang) });
  }
  facts.push({
    label: t.lastRun,
    value: dateOrNone(input.template.schedule.lastRun, t.noneYet, lang),
  });
  const total = totalText(input, lang);
  if (total !== undefined) facts.push({ label: t.total, value: total });
  return facts;
}

const ISSUES_AGAIN: Phrase = phrase(
  "Once reactivated, sevDesk again creates an invoice from this template on every run date by " +
    "itself, with its stored positions and texts; nobody is asked again. This approval covers " +
    "every one of those invoices until the template ends.",
  "Nach dem Aktivieren erzeugt sevDesk wieder an jedem Ausführungstag selbst eine Rechnung aus " +
    "dieser Vorlage, mit ihren gespeicherten Positionen und Texten; niemand wird erneut gefragt. " +
    "Diese Freigabe gilt für alle diese Rechnungen, bis die Vorlage endet.",
);

const RUN_TODAY_REACTIVATING: Phrase = phrase(
  "The next run is today: sevDesk may create an invoice as soon as the template is active.",
  "Die nächste Ausführung ist heute: sevDesk erzeugt womöglich eine Rechnung, sobald die " +
    "Vorlage aktiv ist.",
);

function reactivateWarnings(input: StatusPreviewInput, lang: PreviewLanguage): string[] {
  const { projected } = input;
  const list: (string | undefined)[] = [
    ISSUES_AGAIN[lang],
    RUN_DATE_BEHAVIOUR[lang],
    projected?.startDate === input.today ? RUN_TODAY_REACTIVATING[lang] : undefined,
    projected !== undefined && !runDayFitsEveryMonth(projected)
      ? SHORT_MONTH_RUNS[lang]
      : undefined,
    projected === undefined ? undefined : endOnRunWarning(projected, lang),
  ];
  return list.filter((warning): warning is string => warning !== undefined);
}
