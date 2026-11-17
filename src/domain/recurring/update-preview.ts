/**
 * The confirmation preview of a change to a recurring invoice template, in English and German from
 * the same data (`../preview-text.ts`): the same facts and warnings in the same order.
 *
 * Every invoice sevDesk creates from the template after the change carries it, without asking
 * anyone again, so the preview names each change as before → after, shows new texts and every new
 * position in full, the total per invoice before and after, and the run dates after the change.
 * The approval is also bound to the exact body sent (`update.ts`).
 */
import { cleanText, trimmedText } from "../common.js";
import type { Amounts, DraftPosition, PriceMode } from "../drafts/positions.js";
import { addressText, type DraftPreview, moneyText, type PreviewFact } from "../drafts/preview.js";
import type { UpdateBasics } from "../drafts/shared.js";
import {
  taxRuleLabel,
  taxRuleWarnings,
  UNKNOWN_REGIME_WARNING,
  UNKNOWN_REGIME_WARNING_DE,
} from "../drafts/tax.js";
import {
  bothPreviews,
  dateText,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "../preview-text.js";
import {
  endOnRunWarning,
  endText,
  followingRunsText,
  intervalText,
  positionText,
  priceModeText,
  SHORT_MONTH_RUNS,
} from "./preview.js";
import { FIRST_RUN_TODAY, RUN_DATE_BEHAVIOUR, runTodayAtStoredTime } from "./run-date.js";
import {
  INTERVALS,
  type RecurringInterval,
  runDayFitsEveryMonth,
  type Schedule,
  type StoredSchedule,
} from "./schedule.js";
import { generationOnPhrase, generationText, type TemplateState } from "./template.js";

const NAME_MAX = 200;

/** The schedule after a change, and which of its parts change (built in `update.ts`). */
export interface ScheduleChange {
  readonly interval: RecurringInterval | undefined;
  readonly intervalChanged: boolean;
  readonly startChanged: boolean;
  readonly startDate: string | undefined;
  readonly nextRun: string | undefined;
  readonly endChanged: boolean;
  readonly endDate: string | undefined;
}

/** Automatic generation as stored (D-132): on, off, unrecorded, or not returned. */
type GenerationState = StoredSchedule["autoGenerate"];

/** Automatic generation before and after a change (built in `update.ts`). */
export interface GenerationChange {
  readonly before: GenerationState;
  readonly after: GenerationState;
  readonly changed: boolean;
}

/** What a change preview is built from. */
export interface TemplateUpdatePreviewInput {
  readonly id: number;
  readonly state: TemplateState;
  /** Berlin's `YYYY-MM-DD` when the call is prepared. */
  readonly today: string;
  readonly basics: UpdateBasics;
  readonly storedContactId: number | undefined;
  readonly storedContactPersonId: number | undefined;
  readonly storedMode: PriceMode;
  /** Stored values (cleaned upstream text where text). */
  readonly before: {
    readonly header: string | undefined;
    readonly timeToPay: number | undefined;
    readonly positions: number;
    readonly gross: string | undefined;
  };
  /** The values the body sends; `undefined` where nothing changes. */
  readonly after: {
    readonly header: string | undefined;
    readonly headText: string | undefined;
    readonly footText: string | undefined;
    readonly timeToPay: number | undefined;
    readonly positions: readonly DraftPosition[] | undefined;
    readonly expected: Amounts | undefined;
  };
  readonly stored: StoredSchedule;
  readonly schedule: ScheduleChange;
  readonly generation: GenerationChange;
  /** The runs from the next run on, after the change; none without a known interval or next run. */
  readonly projected: Schedule | undefined;
}

const LABELS = {
  en: {
    template: "Template",
    autoGenerate: "Automatic generation (Automatische Generierung)",
    customer: "Customer",
    address: "Address on the invoices",
    contactPerson: "Contact person (Ansprechpartner)",
    title: "Title (Betreff)",
    paymentTerm: "Payment term (Zahlungsziel)",
    priceMode: "Prices entered as",
    taxRule: "Tax rule (Steuerregel)",
    taxNote: "Tax note (Steuerhinweis)",
    headText: "Head text (Kopftext), new",
    positions: "Positions",
    position: "Position",
    footText: "Foot text (Fußtext), new",
    interval: "Interval",
    startDate: "Start date",
    endDate: "End date",
    nextRun: "Next run",
    followingRuns: "Following runs",
    end: "End",
    total: "Total per invoice",
    none: "none",
    days: "days",
    user: "user",
    contact: "contact",
  },
  de: {
    template: "Vorlage",
    autoGenerate: "Automatische Generierung",
    customer: "Kunde",
    address: "Anschrift auf den Rechnungen",
    contactPerson: "Ansprechpartner",
    title: "Betreff",
    paymentTerm: "Zahlungsziel",
    priceMode: "Preise eingegeben als",
    taxRule: "Steuerregel",
    taxNote: "Steuerhinweis",
    headText: "Kopftext, neu",
    positions: "Positionen",
    position: "Position",
    footText: "Fußtext, neu",
    interval: "Intervall",
    startDate: "Startdatum",
    endDate: "Enddatum",
    nextRun: "Nächste Ausführung",
    followingRuns: "Folgende Ausführungen",
    end: "Ende",
    total: "Summe je Rechnung",
    none: "keines",
    days: "Tage",
    user: "Benutzer",
    contact: "Kontakt",
  },
} as const;

/** The changes an update can make, named in both languages (action sentence). */
const CHANGE_NAMES = {
  customer: phrase("customer", "Kunde"),
  address: phrase("address", "Anschrift"),
  "contact person": phrase("contact person", "Ansprechpartner"),
  title: phrase("title", "Betreff"),
  "payment term": phrase("payment term", "Zahlungsziel"),
  "price mode": phrase("price mode", "Preisangabe"),
  tax: phrase("tax", "Steuer"),
  "head text": phrase("head text", "Kopftext"),
  positions: phrase("positions", "Positionen"),
  "foot text": phrase("foot text", "Fußtext"),
  interval: phrase("interval", "Intervall"),
  "start date": phrase("start date", "Startdatum"),
  "end date": phrase("end date", "Enddatum"),
  "automatic generation": phrase("automatic generation", "automatische Generierung"),
} as const satisfies Record<string, Phrase>;

/** A change an update makes (see {@link CHANGE_NAMES}). */
export type ChangeName = keyof typeof CHANGE_NAMES;

/** The preview in both languages; `changed` lists what the body changes, in preview order. */
export function templateUpdatePreviews(
  input: TemplateUpdatePreviewInput,
  changed: readonly ChangeName[],
): { readonly preview: DraftPreview; readonly previewDe: DraftPreview } {
  return bothPreviews((lang) => ({
    action: actionText(input, changed, lang),
    facts: facts(input, lang),
    warnings: warnings(input, changed, lang),
    irreversible: false,
  }));
}

function customerName(input: TemplateUpdatePreviewInput, lang: PreviewLanguage): string {
  return (
    cleanText(input.basics.contact.contact.displayName, NAME_MAX) ??
    (lang === "de" ? "(ohne Namen)" : "(unnamed)")
  );
}

function customerText(input: TemplateUpdatePreviewInput, lang: PreviewLanguage): string {
  const t = LABELS[lang];
  return `${customerName(input, lang)} (${t.contact} ${String(input.basics.contact.contact.id)})`;
}

function actionText(
  input: TemplateUpdatePreviewInput,
  changed: readonly ChangeName[],
  lang: PreviewLanguage,
): string {
  const list = changed.map((name) => CHANGE_NAMES[name][lang]).join(", ");
  return lang === "de"
    ? `Abo-Rechnung ${String(input.id)} für ${customerText(input, lang)} ändern: ${list}.`
    : `Change recurring invoice template ${String(input.id)} (Abo-Rechnung) for ` +
        `${customerText(input, lang)}: ${list}.`;
}

function arrow(before: string | undefined, after: string | undefined, none: string): string {
  return `${before ?? none} → ${after ?? none}`;
}

/**
 * The interval as stored: the offered interval's name and form; for one made in the web app, its
 * description (English) or the raw form (German).
 */
function storedIntervalText(stored: StoredSchedule, lang: PreviewLanguage): string {
  if (stored.intervalKey !== undefined) {
    return `${INTERVALS[stored.intervalKey][lang]} (${stored.interval ?? ""})`;
  }
  if (stored.interval === undefined) return LABELS[lang].none;
  return lang === "en" && stored.every !== undefined
    ? `${stored.every} (${stored.interval})`
    : stored.interval;
}

function newIntervalText(input: TemplateUpdatePreviewInput, lang: PreviewLanguage): string {
  const { projected, schedule } = input;
  if (projected !== undefined) return intervalText(projected, lang);
  const key = schedule.interval;
  return key === undefined ? LABELS[lang].none : `${INTERVALS[key][lang]} (${INTERVALS[key].wire})`;
}

function totalsText(amounts: Amounts, currency: string, lang: PreviewLanguage): string {
  const words = lang === "de" ? ["netto", "USt.", "brutto"] : ["net", "tax", "gross"];
  return [amounts.net, amounts.tax, amounts.gross]
    .map((amount, index) => `${words[index] ?? ""} ${moneyText(amount, currency, lang)}`)
    .join(", ");
}

function totalText(input: TemplateUpdatePreviewInput, lang: PreviewLanguage): string | undefined {
  const { currency } = input.basics;
  const before =
    input.before.gross === undefined
      ? undefined
      : `${lang === "de" ? "brutto" : "gross"} ${moneyText(input.before.gross, currency, lang)}`;
  const { expected } = input.after;
  if (expected === undefined) {
    if (before === undefined) return undefined;
    return lang === "de" ? `unverändert: ${before}` : `unchanged: ${before}`;
  }
  return arrow(before, totalsText(expected, currency, lang), LABELS[lang].none);
}

function taxRuleText(input: TemplateUpdatePreviewInput, lang: PreviewLanguage): string | undefined {
  const { rule, tax } = input.basics;
  if (rule === undefined) return undefined;
  const taxType = tax.taxType;
  if (taxType === undefined) return taxRuleLabel(rule);
  return lang === "de"
    ? `Steuerart ${taxType} (aus Steuerregel ${taxRuleLabel(rule)}), Buchhaltung 1.0`
    : `tax type ${taxType} (from tax rule ${taxRuleLabel(rule)}), bookkeeping 1.0`;
}

function nextRunText(input: TemplateUpdatePreviewInput, lang: PreviewLanguage): string {
  const next = input.schedule.nextRun;
  const de = lang === "de";
  if (input.state === "ended") {
    if (next === undefined)
      return de ? "keine, solange die Vorlage beendet ist" : "none while the template is ended";
    return de
      ? `keine, solange die Vorlage beendet ist (sevDesk behält ${dateText(next, lang)} als Datum)`
      : `none while the template is ended (sevDesk keeps ${next} as its date)`;
  }
  if (next === undefined) return de ? "keine gespeichert" : "none stored";
  return dateText(next, lang);
}

function facts(input: TemplateUpdatePreviewInput, lang: PreviewLanguage): PreviewFact[] {
  const t = LABELS[lang];
  const { basics, before, after, schedule, stored } = input;
  const list: PreviewFact[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined && trimmedText(value) !== undefined) list.push({ label, value });
  };
  const de = lang === "de";

  add(
    t.template,
    `${String(input.id)} (${de ? "Abo-Rechnung" : "recurring invoice template"}, ` +
      `${input.state === "ended" ? (de ? "beendet" : "ended") : de ? "aktiv" : "active"})`,
  );
  const { generation } = input;
  add(
    t.autoGenerate,
    generation.changed
      ? arrow(generationText(generation.before, lang), generationText(generation.after, lang), "")
      : generationText(generation.before, lang),
  );
  add(
    t.customer,
    basics.contactChanged
      ? `${t.contact} ${String(input.storedContactId ?? "–")} → ${customerText(input, lang)}`
      : customerText(input, lang),
  );
  if (basics.address !== undefined) {
    add(t.address, arrow(basics.addressBefore, addressText(basics.address), t.none));
  }
  if (basics.contactPersonChanged) {
    const name = cleanText(basics.contactPerson.name, NAME_MAX);
    const now = `${name === undefined ? "" : `${name} `}(${t.user} ${String(basics.contactPerson.id)})`;
    add(
      t.contactPerson,
      arrow(
        input.storedContactPersonId === undefined
          ? undefined
          : `${t.user} ${String(input.storedContactPersonId)}`,
        now,
        t.none,
      ),
    );
  }
  if (after.header !== undefined) {
    add(t.title, arrow(before.header, cleanText(after.header, NAME_MAX), t.none));
  }
  if (after.timeToPay !== undefined) {
    add(
      t.paymentTerm,
      arrow(
        before.timeToPay === undefined ? undefined : `${String(before.timeToPay)} ${t.days}`,
        `${String(after.timeToPay)} ${t.days}`,
        t.none,
      ),
    );
  }
  if (basics.modeChanged) {
    add(
      t.priceMode,
      arrow(priceModeText(input.storedMode, lang), priceModeText(basics.mode, lang), t.none),
    );
  }
  if (basics.taxChanged) {
    add(t.taxRule, taxRuleText(input, lang));
    add(t.taxNote, basics.tax.taxText);
  }
  add(t.headText, after.headText);
  if (after.positions !== undefined) {
    const count = (n: number): string =>
      de
        ? `${String(n)} Position${n === 1 ? "" : "en"}`
        : `${String(n)} position${n === 1 ? "" : "s"}`;
    add(
      t.positions,
      de
        ? `${count(before.positions)} durch ${count(after.positions.length)} ersetzen`
        : `replace ${count(before.positions)} with ${count(after.positions.length)}`,
    );
    after.positions.forEach((position, index) => {
      add(
        `${t.position} ${String(index + 1)}`,
        positionText(position, basics.mode, basics.currency, lang),
      );
    });
  }
  add(t.footText, after.footText);
  if (schedule.intervalChanged) {
    add(t.interval, arrow(storedIntervalText(stored, lang), newIntervalText(input, lang), t.none));
  } else if (stored.intervalKey === undefined && stored.interval !== undefined) {
    // One this server does not offer (made in the web app): shown as stored, since no run is listed.
    add(t.interval, storedIntervalText(stored, lang));
  }
  if (schedule.startChanged && schedule.startDate !== undefined) {
    add(
      t.startDate,
      arrow(
        stored.startDate === undefined ? undefined : dateText(stored.startDate, lang),
        `${dateText(schedule.startDate, lang)} ` +
          (de
            ? "(auch die nächste Ausführung; die letzte Ausführung wird gelöscht)"
            : "(also the next run; the last run is cleared)"),
        t.none,
      ),
    );
  }
  if (schedule.endChanged) {
    add(
      t.endDate,
      arrow(
        stored.endDate === undefined ? undefined : dateText(stored.endDate, lang),
        schedule.endDate === undefined ? undefined : dateText(schedule.endDate, lang),
        t.none,
      ),
    );
  }

  add(t.nextRun, nextRunText(input, lang));
  if (input.state === "active") {
    const { projected } = input;
    if (projected !== undefined) {
      add(t.followingRuns, followingRunsText(projected, lang));
      add(t.end, endText(projected, lang));
    } else if (schedule.nextRun !== undefined) {
      add(
        t.followingRuns,
        de
          ? "nicht berechnet: das gespeicherte Intervall bietet dieser Server nicht an"
          : "not computed: the stored interval is not one this server offers",
      );
    }
  }
  if (input.state === "ended" || input.projected === undefined) {
    add(t.end, schedule.endDate === undefined ? t.none : dateText(schedule.endDate, lang));
  }
  add(t.total, totalText(input, lang));
  return list;
}

const APPLIES_FROM_NEXT_RUN: Phrase = phrase(
  "Every invoice sevDesk creates from this template by itself after the change carries it; " +
    "nobody is asked again. This approval covers all of them until the template ends.",
  "Jede Rechnung, die sevDesk nach der Änderung selbst aus dieser Vorlage erzeugt, übernimmt " +
    "sie; niemand wird erneut gefragt. Diese Freigabe gilt für alle diese Rechnungen, bis die " +
    "Vorlage endet.",
);

const ENDED_APPLIES_LATER: Phrase = phrase(
  "The template is ended (status 50): sevDesk creates no invoice from it now. The change applies " +
    "once it is reactivated with sevdesk_invoice_reactivate_recurring.",
  "Die Vorlage ist beendet (Status 50): sevDesk erzeugt derzeit keine Rechnung aus ihr. Die " +
    "Änderung gilt, sobald sie mit sevdesk_invoice_reactivate_recurring wieder aktiviert wird.",
);

const KEEPS_CREATED: Phrase = phrase(
  "Invoices sevDesk already created from this template stay as they are; the change applies " +
    "only to later ones.",
  "Rechnungen, die sevDesk aus dieser Vorlage schon erzeugt hat, bleiben, wie sie sind; die " +
    "Änderung gilt nur für spätere.",
);

const START_MOVES_NEXT: Phrase = phrase(
  "sevDesk moves the next run to the new start date as well and clears the template's last run " +
    "(recorded). The new start lies after the period of every invoice the template has generated, " +
    "so no period is billed twice.",
  "sevDesk verlegt die nächste Ausführung ebenfalls auf das neue Startdatum und löscht die letzte " +
    "Ausführung der Vorlage (erfasst). Der neue Start liegt nach dem Zeitraum jeder Rechnung, die " +
    "die Vorlage erzeugt hat, sodass kein Zeitraum doppelt abgerechnet wird.",
);

const GENERATION_UNRECORDED: Phrase = phrase(
  "Automatic generation has a stored value whose meaning is not recorded (see " +
    "schedule.autoGenerateValue), so whether sevDesk generates invoices from this template is " +
    "unknown. Set autoGenerate to switch it on or off.",
  "Die automatische Generierung hat einen gespeicherten Wert, dessen Bedeutung nicht erfasst ist " +
    "(siehe schedule.autoGenerateValue); ob sevDesk aus dieser Vorlage Rechnungen erzeugt, ist " +
    "daher unbekannt. Mit autoGenerate lässt sie sich ein- oder ausschalten.",
);

/** What sevDesk does on a run date with the generation the template has after the change. */
function generationSentence(
  input: TemplateUpdatePreviewInput,
  lang: PreviewLanguage,
): string | undefined {
  switch (input.generation.after) {
    case "on":
      return generationOnPhrase(input.stored)[lang];
    case "off":
      return RUN_DATE_BEHAVIOUR.off[lang];
    case "unrecorded":
      return GENERATION_UNRECORDED[lang];
    case undefined:
      return undefined;
  }
}

const UNKNOWN_INTERVAL: Phrase = phrase(
  "The stored interval is not one this server offers, so the following runs are not listed; " +
    "set interval to replace it.",
  "Das gespeicherte Intervall bietet dieser Server nicht an, daher werden die folgenden " +
    "Ausführungen nicht genannt; mit interval lässt es sich ersetzen.",
);

function intervalKeepsNext(next: string, lang: PreviewLanguage): string {
  return lang === "de"
    ? `Bei einem neuen Intervall behält sevDesk die nächste Ausführung (${dateText(next, lang)}); ` +
        "die Ausführungen danach folgen dem neuen Intervall."
    : `With a new interval sevDesk keeps the next run (${next}); the runs after it follow the ` +
        "new interval.";
}

/** The changes that decide when or whether invoices are made, not what they carry. */
const SCHEDULE_CHANGES: ReadonlySet<ChangeName> = new Set<ChangeName>([
  "interval",
  "start date",
  "end date",
  "automatic generation",
]);

const RUN_TODAY_OLD_CONTENT: Phrase = phrase(
  "The next run is today: a draft sevDesk has already created from this template today, or " +
    "creates before this change is saved, keeps the old content. Check today's draft before it is " +
    "finalized.",
  "Die nächste Ausführung ist heute: Ein Entwurf, den sevDesk heute schon aus dieser Vorlage " +
    "erzeugt hat oder vor dem Speichern dieser Änderung erzeugt, behält den alten Inhalt. Prüfe den " +
    "heutigen Entwurf, bevor er fertiggestellt wird.",
);

/**
 * Generation switched on with the next run today: due at once at 00:00, else at the run time
 * stored with the next run (a template made in the web app).
 */
function firstRunToday(stored: StoredSchedule): Phrase {
  return stored.runTime === undefined
    ? FIRST_RUN_TODAY
    : runTodayAtStoredTime(stored.runTime, "change");
}

/** Consequences first, then notes on the schedule, then the tax rule. */
function warnings(
  input: TemplateUpdatePreviewInput,
  changed: readonly ChangeName[],
  lang: PreviewLanguage,
): string[] {
  const { schedule, projected, basics, generation } = input;
  const active = input.state === "active";
  const taxOrPositions = basics.taxChanged || input.after.positions !== undefined;
  const switchedOn = generation.changed && generation.after === "on";
  const runsToday = active && schedule.nextRun === input.today;
  const contentChanged = changed.some((name) => !SCHEDULE_CHANGES.has(name));
  // With generation on before the call too, today's draft may exist already, with the old content.
  const keptOnToday = runsToday && generation.after === "on" && !generation.changed;
  const list: (string | undefined)[] = [
    active ? APPLIES_FROM_NEXT_RUN[lang] : ENDED_APPLIES_LATER[lang],
    KEEPS_CREATED[lang],
    keptOnToday && contentChanged ? RUN_TODAY_OLD_CONTENT[lang] : undefined,
    active || generation.changed ? generationSentence(input, lang) : undefined,
    switchedOn ? RUN_DATE_BEHAVIOUR.autoSending[lang] : undefined,
    switchedOn && runsToday ? firstRunToday(input.stored)[lang] : undefined,
    schedule.intervalChanged && !schedule.startChanged && schedule.nextRun !== undefined
      ? intervalKeepsNext(schedule.nextRun, lang)
      : undefined,
    schedule.startChanged ? START_MOVES_NEXT[lang] : undefined,
    active && projected === undefined && schedule.interval === undefined
      ? UNKNOWN_INTERVAL[lang]
      : undefined,
    active && projected !== undefined && !runDayFitsEveryMonth(projected)
      ? SHORT_MONTH_RUNS[lang]
      : undefined,
    active && projected !== undefined ? endOnRunWarning(projected, lang) : undefined,
    basics.regime === undefined && taxOrPositions
      ? lang === "de"
        ? UNKNOWN_REGIME_WARNING_DE
        : UNKNOWN_REGIME_WARNING
      : undefined,
    ...(basics.rule !== undefined && taxOrPositions
      ? taxRuleWarnings(basics.rule, basics.regime, lang)
      : []),
  ];
  return list.filter((warning): warning is string => warning !== undefined);
}
