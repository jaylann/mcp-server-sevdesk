/**
 * Ending and reactivating a recurring invoice template (Abo-Rechnung, type WKR).
 *
 * Recorded (spec/deviations.md D-112, D-132; 2026-11-16 and 2026-11-17): `saveInvoice` with the
 * template's id and `status: "50"` ends it, `status: "100"` sets it back, and neither changes a
 * schedule field, a position or automatic generation. The body carries nothing else
 * (`templateStatusBodySchema`), so the save cannot change the template's content. An ended
 * template generates nothing, even with automatic generation on; set back to 100 with generation
 * on and a run due, it generated a draft within a minute. Ending does not touch the invoices
 * sevDesk already generated.
 *
 * Whether a reactivated template generates anything is decided by its automatic generation:
 * - on: sevDesk generates drafts again, at once when the next run is today (at its stored run time
 *   when that is later, for one made in the web app). A next run before today is refused, since
 *   sevDesk catches up one missed period a minute (D-111);
 * - off (never set or switched off): reactivating alone generates nothing, which the preview says;
 * - a stored value whose meaning is not recorded: refused, so the outcome is never a guess.
 * A template with automatic sending on, or whose settings sevDesk did not return, is not
 * reactivated here (`assertNoAutoSending`); ending one is always allowed, since it stops the
 * e-mails.
 */
import { canonicalJson, sha256Hex } from "../../safety/hashing.js";
import { SevdeskError } from "../../sevdesk/errors.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { cleanText, trimmedText } from "../common.js";
import type { CountryReadOptions } from "../country-codes.js";
import { todayInBerlin } from "../drafts/fields.js";
import { strictBody } from "../drafts/payloads.js";
import type { DraftPreview, PreviewFact } from "../drafts/preview.js";
import { moneyText } from "../drafts/preview.js";
import { readBack } from "../drafts/read-back.js";
import { getInvoice } from "../invoices.js";
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
import { RUN_DATE_BEHAVIOUR, runTodayAtStoredTime, TEMPLATE_SAVE_STATUS } from "./run-date.js";
import {
  ENDED_STATUS,
  runDayFitsEveryMonth,
  type Schedule,
  scheduleFrom,
  type StoredSchedule,
} from "./schedule.js";
import {
  assertNoAutoSending,
  assertTemplate,
  type ExpectedSchedule,
  generationOnPhrase,
  generationText,
  loadTemplate,
  sameTemplateSaved,
  scheduleNotes,
  type StoredTemplate,
  templateOf,
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
 * Reads the template with its settings, checks that the change does something and is safe, and
 * builds the body and both previews. Throws `validation` errors; sends nothing.
 */
export async function prepareTemplateStatus(
  client: SevdeskClient,
  id: number,
  change: TemplateStatusChange,
  options: CountryReadOptions,
): Promise<TemplateStatusPlan> {
  const template = await loadTemplate(client, id, options);
  const { invoice } = template.details;
  const { schedule } = template;
  assertTemplate(
    id,
    invoice.type.code,
    TOOL[change],
    "Find recurring invoice templates with sevdesk_invoices_list (type recurring).",
  );
  const state = templateState(id, invoice.status.code);
  const today = todayInBerlin();
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
    assertNoAutoSending(id, schedule, "reactivated");
    checkReactivation(id, schedule, today);
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
  const { intervalKey, nextRun, endDate } = schedule;
  const projected =
    intervalKey === undefined || nextRun === undefined
      ? undefined
      : scheduleFrom(intervalKey, nextRun, endDate);
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
 * Refuses a reactivation whose outcome is unknown or would bill more than the preview shows: a
 * generation value whose meaning is not recorded; with generation on, no next run, a next run
 * before today (sevDesk would catch up the missed periods at once), or an end before the next run.
 * With generation off, reactivating generates nothing, so the dates refuse nothing.
 */
function checkReactivation(id: number, schedule: StoredSchedule, today: string): void {
  if (schedule.autoGenerate === "unrecorded") {
    refuse(
      `Recurring invoice template ${String(id)} has a value for automatic generation ` +
        "(Automatische Generierung) whose meaning is not recorded (see schedule.autoGenerateValue " +
        "in sevdesk_invoice_get), so whether sevDesk would generate invoices cannot be said. " +
        "Switch it on or off with sevdesk_invoice_update_recurring (autoGenerate) first, then " +
        "reactivate it.",
    );
  }
  if (schedule.autoGenerate !== "on") return;
  const { nextRun, endDate } = schedule;
  const newStart =
    "Give it a new start date first with sevdesk_invoice_update_recurring (startDate), then " +
    "reactivate it.";
  if (nextRun === undefined) {
    refuse(
      `Recurring invoice template ${String(id)} has automatic generation on but no next run ` +
        `date, so when sevDesk would create the next invoice cannot be shown. ${newStart}`,
    );
  }
  if (nextRun < today) {
    refuse(
      `The next run of recurring invoice template ${String(id)} is ${nextRun}, before today ` +
        `(${today} in Berlin), and its automatic generation is on. Reactivated, sevDesk would ` +
        "catch up and create a draft for every period since then, one a minute, which no " +
        `preview shows. ${newStart}`,
    );
  }
  if (endDate !== undefined && endDate < nextRun) {
    refuse(
      `The end date ${endDate} of recurring invoice template ${String(id)} is before its next ` +
        `run ${nextRun}, so reactivating it would create no invoice. Give it a later endDate (or ` +
        "removeEndDate) with sevdesk_invoice_update_recurring first.",
    );
  }
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
  options: CountryReadOptions,
): Promise<TemplateStatusResult> {
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
  const template = await readBack(saved, async () =>
    templateOf(await getInvoice(client, id, options)),
  );
  return {
    id,
    ...template,
    notes: [
      ...templateRecordNotes(id, template.details.invoice, state.status),
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
  /** The runs from the kept next run on, when the interval is one this server offers. */
  readonly projected: Schedule | undefined;
  readonly today: string;
}

const LABELS = {
  en: {
    template: "Template",
    customer: "Customer",
    title: "Title (Betreff)",
    interval: "Interval",
    autoGenerate: "Automatic generation (Automatische Generierung)",
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
    autoGenerate: "Automatische Generierung",
    nextRun: "Nächste Ausführung",
    followingRuns: "Folgende Ausführungen",
    end: "Ende",
    lastRun: "Letzte Ausführung",
    total: "Summe je Rechnung",
    none: "keines",
    noneYet: "noch keine",
  },
} as const;

/** "contact 1001" / "Kontakt 1001": how the action names the customer, by id only (#147). */
function customerRef(input: StatusPreviewInput, lang: PreviewLanguage): string {
  const contact = input.template.details.invoice.contact;
  if (contact === undefined) return lang === "de" ? "(kein Kontakt)" : "(no contact)";
  return `${lang === "de" ? "Kontakt" : "contact"} ${String(contact.id)}`;
}

/** The "Customer" fact: name and id. */
function customerText(input: StatusPreviewInput, lang: PreviewLanguage): string {
  const id = customerRef(input, lang);
  const name = cleanText(input.template.details.invoice.contact?.name, NAME_MAX);
  return name === undefined ? id : `${name} (${id})`;
}

function grossText(input: StatusPreviewInput, lang: PreviewLanguage): string | undefined {
  const gross = input.template.details.invoice.totals.gross;
  return gross === undefined ? undefined : moneyText(gross.amount, gross.currency, lang);
}

function totalText(input: StatusPreviewInput, lang: PreviewLanguage): string | undefined {
  const { net, tax, gross } = input.template.details.invoice.totals;
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

/**
 * The stored interval as a preview names it: the offered interval with its run day, or, for one
 * made in the web app, its description in English and the stored form in German.
 */
function storedIntervalText(schedule: StoredSchedule, lang: PreviewLanguage): string {
  const { interval, intervalKey, nextRun, every } = schedule;
  if (intervalKey !== undefined && nextRun !== undefined) {
    return intervalText(scheduleFrom(intervalKey, nextRun, undefined), lang);
  }
  if (interval === undefined) return lang === "de" ? "keines gespeichert" : "none stored";
  return lang === "de"
    ? `${interval} (kein Intervall, das dieser Server anbietet)`
    : `${every ?? interval} (${interval}; not an interval this server offers)`;
}

function dateOrNone(date: string | undefined, none: string, lang: PreviewLanguage): string {
  return date === undefined ? none : dateText(date, lang);
}

function commonFacts(input: StatusPreviewInput, lang: PreviewLanguage): PreviewFact[] {
  const t = LABELS[lang];
  const { invoice } = input.template.details;
  const { schedule } = input.template;
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
  add(t.autoGenerate, generationText(schedule.autoGenerate, lang));
  return list;
}

function endAction(input: StatusPreviewInput, lang: PreviewLanguage): string {
  const customer = customerRef(input, lang);
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

const ENDED_GENERATES_NOTHING: Phrase = phrase(
  "An ended template generates nothing, even with automatic generation on (recorded). It keeps " +
    "its automatic generation as it is, for a later reactivation.",
  "Eine beendete Vorlage erzeugt nichts, auch nicht bei eingeschalteter automatischer " +
    "Generierung (erfasst). Sie behält ihre automatische Generierung, wie sie ist, für ein " +
    "späteres Aktivieren.",
);

const ENDING_KEEPS_TEMPLATE: Phrase = phrase(
  "The template is kept with its positions and schedule: sevdesk_invoice_reactivate_recurring " +
    "starts it again. A template is deleted only in the sevDesk web app (Abo-Rechnungen).",
  "Die Vorlage bleibt mit ihren Positionen und ihrem Zeitplan erhalten: " +
    "sevdesk_invoice_reactivate_recurring startet sie wieder. Löschen lässt sich eine Vorlage nur " +
    "in der sevDesk-Web-App (Abo-Rechnungen).",
);

const ENDING_STOPS_SENDING: Phrase = phrase(
  "Automatic sending (Automatisches Versenden) is on for this template: ending it stops sevDesk " +
    "from finalizing, e-mailing and enshrining further invoices from it. Reactivating such a " +
    "template is left to the sevDesk web app.",
  "Für diese Vorlage ist das automatische Versenden an: Das Beenden hält sevDesk davon ab, " +
    "weitere Rechnungen aus ihr fertigzustellen, per E-Mail zu versenden und festzuschreiben. " +
    "Eine solche Vorlage wird in der sevDesk-Web-App wieder aktiviert.",
);

const RUN_TODAY_ENDING: Phrase = phrase(
  "The next run is today: if sevDesk has already created today's invoice, ending the template " +
    "does not undo it.",
  "Die nächste Ausführung ist heute: Hat sevDesk die heutige Rechnung schon erzeugt, macht das " +
    "Beenden sie nicht rückgängig.",
);

function endWarnings(input: StatusPreviewInput, lang: PreviewLanguage): string[] {
  const { schedule } = input.template;
  const list: (string | undefined)[] = [
    ENDING_KEEPS_INVOICES[lang],
    ENDED_GENERATES_NOTHING[lang],
    ENDING_KEEPS_TEMPLATE[lang],
    schedule.autoSendConfigured === true ? ENDING_STOPS_SENDING[lang] : undefined,
    schedule.nextRun === input.today ? RUN_TODAY_ENDING[lang] : undefined,
  ];
  return list.filter((warning): warning is string => warning !== undefined);
}

function generating(input: StatusPreviewInput): boolean {
  return input.template.schedule.autoGenerate === "on";
}

function reactivateAction(input: StatusPreviewInput, lang: PreviewLanguage): string {
  const customer = customerRef(input, lang);
  const de = lang === "de";
  if (!generating(input)) {
    return de
      ? `Abo-Rechnung ${String(input.id)} für ${customer} wieder aktivieren; bei ausgeschalteter ` +
          "automatischer Generierung erzeugt sevDesk daraus von selbst nichts."
      : `Reactivate recurring invoice template ${String(input.id)} (Abo-Rechnung) for ` +
          `${customer}; with automatic generation off, sevDesk creates nothing from it by itself.`;
  }
  const gross = grossText(input, lang);
  const next = input.template.schedule.nextRun;
  const nextText = next === undefined ? "" : dateText(next, lang);
  return de
    ? `Abo-Rechnung ${String(input.id)} für ${customer} wieder aktivieren: sevDesk erzeugt aus ` +
        `ihr wieder Rechnungsentwürfe${gross === undefined ? "" : ` über ${gross} brutto`}, den ` +
        `nächsten am ${nextText}.`
    : `Reactivate recurring invoice template ${String(input.id)} (Abo-Rechnung) for ` +
        `${customer}: sevDesk generates draft invoices from it again` +
        `${gross === undefined ? "" : `, ${gross} gross each`}, the next on ${nextText}.`;
}

function reactivateFacts(input: StatusPreviewInput, lang: PreviewLanguage): PreviewFact[] {
  const t = LABELS[lang];
  const facts = commonFacts(input, lang);
  const { projected } = input;
  const { schedule } = input.template;
  if (schedule.nextRun !== undefined) {
    facts.push({ label: t.nextRun, value: dateText(schedule.nextRun, lang) });
  }
  if (projected !== undefined) {
    facts.push({ label: t.followingRuns, value: followingRunsText(projected, lang) });
    facts.push({ label: t.end, value: endText(projected, lang) });
  } else {
    if (schedule.nextRun !== undefined) {
      facts.push({
        label: t.followingRuns,
        value:
          lang === "de"
            ? "nicht berechnet: das gespeicherte Intervall bietet dieser Server nicht an"
            : "not computed: the stored interval is not one this server offers",
      });
    }
    facts.push({ label: t.end, value: dateOrNone(schedule.endDate, t.none, lang) });
  }
  facts.push({ label: t.lastRun, value: dateOrNone(schedule.lastRun, t.noneYet, lang) });
  const total = totalText(input, lang);
  if (total !== undefined) facts.push({ label: t.total, value: total });
  return facts;
}

const GENERATES_AGAIN: Phrase = phrase(
  "Once reactivated, sevDesk again creates a draft invoice from this template on every run date " +
    "by itself, with its stored positions and texts; nobody is asked again. This approval covers " +
    "every one of those drafts until the template ends.",
  "Nach dem Aktivieren erzeugt sevDesk wieder an jedem Ausführungstag selbst einen " +
    "Rechnungsentwurf aus dieser Vorlage, mit ihren gespeicherten Positionen und Texten; niemand " +
    "wird erneut gefragt. Diese Freigabe gilt für alle diese Entwürfe, bis die Vorlage endet.",
);

const REACTIVATED_OFF: Phrase = phrase(
  "Automatic generation is off for this template, so reactivating it alone generates nothing. " +
    "sevDesk creates drafts from it only once automatic generation is switched on: with " +
    "sevdesk_invoice_update_recurring (autoGenerate true) or in the sevDesk web app.",
  "Für diese Vorlage ist die automatische Generierung aus, daher erzeugt das Aktivieren allein " +
    "nichts. sevDesk erzeugt erst Entwürfe aus ihr, wenn die automatische Generierung " +
    "eingeschaltet wird: mit sevdesk_invoice_update_recurring (autoGenerate true) oder in der " +
    "sevDesk-Web-App.",
);

function pastNextRunWhileOff(nextRun: string, lang: PreviewLanguage): string {
  return lang === "de"
    ? `Die nächste Ausführung (${dateText(nextRun, lang)}) liegt vor heute: Vor dem Einschalten ` +
        "der automatischen Generierung braucht die Vorlage ein neues Startdatum, sonst würde " +
        "sevDesk die versäumten Zeiträume nachholen."
    : `The next run (${nextRun}) lies before today: before automatic generation is switched on, ` +
        "the template needs a new start date, or sevDesk would catch up the missed periods.";
}

const RUN_TODAY_REACTIVATING: Phrase = phrase(
  "The next run is today, so it is due at once: sevDesk creates a draft within about a minute of " +
    "the reactivation.",
  "Die nächste Ausführung ist heute und damit sofort fällig: sevDesk erzeugt etwa eine Minute " +
    "nach dem Aktivieren einen Entwurf.",
);

/** A next run today: due at once at 00:00, else at the run time stored with it. */
function runTodayPhrase(schedule: StoredSchedule): Phrase {
  return schedule.runTime === undefined
    ? RUN_TODAY_REACTIVATING
    : runTodayAtStoredTime(schedule.runTime, "reactivation");
}

const RUNS_NOT_LISTED: Phrase = phrase(
  "The stored interval is not one this server offers, so the runs after the next one are not " +
    "listed; check them in the sevDesk web app.",
  "Das gespeicherte Intervall bietet dieser Server nicht an, daher werden die Ausführungen nach " +
    "der nächsten nicht genannt; prüfe sie in der sevDesk-Web-App.",
);

function reactivateWarnings(input: StatusPreviewInput, lang: PreviewLanguage): string[] {
  const { projected, today } = input;
  const { schedule } = input.template;
  if (!generating(input)) {
    const next = schedule.nextRun;
    return [
      REACTIVATED_OFF[lang],
      ...(next !== undefined && next < today ? [pastNextRunWhileOff(next, lang)] : []),
    ];
  }
  const list: (string | undefined)[] = [
    GENERATES_AGAIN[lang],
    generationOnPhrase(schedule)[lang],
    RUN_DATE_BEHAVIOUR.autoSending[lang],
    schedule.nextRun === today ? runTodayPhrase(schedule)[lang] : undefined,
    projected === undefined ? RUNS_NOT_LISTED[lang] : undefined,
    projected !== undefined && !runDayFitsEveryMonth(projected)
      ? SHORT_MONTH_RUNS[lang]
      : undefined,
    projected === undefined ? undefined : endOnRunWarning(projected, lang),
  ];
  return list.filter((warning): warning is string => warning !== undefined);
}
