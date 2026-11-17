/**
 * The confirmation preview of a new recurring invoice template, in English and German from the
 * same data (`../preview-text.ts`): the same facts and warnings in the same order.
 *
 * A template prints its texts and positions on every invoice sevDesk creates from it, without
 * asking anyone again, so the human approves all of it here: the texts in full (not cut, as the
 * finalize approval shows a draft's, `../lifecycle/content.ts`), every position, the totals per
 * invoice, the schedule with its next run dates, and whether sevDesk creates the drafts by itself
 * (automatic generation), with what that means on a run date (`run-date.ts`). The approval is also
 * bound to the exact body that is sent (`create.ts`), the switch included.
 */
import { cleanText, trimmedText } from "../common.js";
import type { NewInvoiceContent } from "../drafts/invoice.js";
import { type DraftPosition, positionAmounts, type PriceMode } from "../drafts/positions.js";
import { addressText, type DraftPreview, moneyText, type PreviewFact } from "../drafts/preview.js";
import type { CreateBasics } from "../drafts/shared.js";
import {
  taxRuleLabel,
  taxRuleWarnings,
  UNKNOWN_REGIME_WARNING,
  UNKNOWN_REGIME_WARNING_DE,
} from "../drafts/tax.js";
import { decimal, format } from "../money.js";
import {
  bothPreviews,
  dateText,
  numberText,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "../preview-text.js";
import { FIRST_RUN_TODAY, RUN_DATE_BEHAVIOUR } from "./run-date.js";
import { endsOnRun, INTERVALS, runCount, runDates, type Schedule } from "./schedule.js";

/** Runs listed after the first one. */
const FOLLOWING_RUNS = 3;
const NAME_MAX = 200;
/** Unity 1 ("Stk"), the unit a position gets when the call names none (`../drafts/positions.ts`). */
const DEFAULT_UNIT_ID = 1;

/** What the preview is built from. */
export interface TemplatePreviewInput {
  readonly contactId: number;
  readonly basics: CreateBasics;
  readonly content: NewInvoiceContent;
  readonly schedule: Schedule;
  /** Whether sevDesk creates a draft on every run date by itself (Automatische Generierung). */
  readonly autoGenerate: boolean;
  /** Berlin's `YYYY-MM-DD` when the call is prepared. */
  readonly today: string;
  /** Ids of templates for the same customer with the same gross total, not deactivated. */
  readonly similar: readonly number[];
}

const HOW_TO_END: Phrase = phrase(
  "To change, pause or end the template later, or to switch automatic generation on or off, use " +
    "the sevDesk web app (Abo-Rechnungen); this server has no tool for that yet.",
  "Ändern, pausieren oder beenden lässt sich die Vorlage vorerst nur in der sevDesk-Web-App " +
    "(Abo-Rechnungen); dort wird auch die automatische Generierung ein- oder ausgeschaltet. " +
    "Dieser Server hat dafür noch kein Werkzeug.",
);

const AUTO_GENERATE_TEXT: Readonly<Record<"on" | "off", Phrase>> = {
  on: phrase(
    "on (sevDesk creates a draft invoice on every run date)",
    "an (sevDesk erzeugt an jedem Ausführungstag einen Rechnungsentwurf)",
  ),
  off: phrase("off (sevDesk creates nothing by itself)", "aus (sevDesk erzeugt von selbst nichts)"),
};

const LABELS = {
  en: {
    customer: "Customer",
    address: "Address on the invoices",
    interval: "Interval",
    firstRun: "First run",
    followingRuns: "Following runs",
    end: "End",
    autoGenerate: "Automatic generation (Automatische Generierung)",
    contactPerson: "Contact person (Ansprechpartner)",
    title: "Title (Betreff)",
    paymentTerm: "Payment term (Zahlungsziel)",
    priceMode: "Prices entered as",
    taxRule: "Tax rule (Steuerregel)",
    taxNote: "Tax note (Steuerhinweis)",
    headText: "Head text (Kopftext)",
    position: "Position",
    footText: "Foot text (Fußtext)",
    total: "Total per invoice",
  },
  de: {
    customer: "Kunde",
    address: "Anschrift auf den Rechnungen",
    interval: "Intervall",
    firstRun: "Erste Ausführung",
    followingRuns: "Folgende Ausführungen",
    end: "Ende",
    autoGenerate: "Automatische Generierung",
    contactPerson: "Ansprechpartner",
    title: "Betreff",
    paymentTerm: "Zahlungsziel",
    priceMode: "Preise eingegeben als",
    taxRule: "Steuerregel",
    taxNote: "Steuerhinweis",
    headText: "Kopftext",
    position: "Position",
    footText: "Fußtext",
    total: "Summe je Rechnung",
  },
} as const;

/** The preview in both languages. */
export function templatePreviews(input: TemplatePreviewInput): {
  readonly preview: DraftPreview;
  readonly previewDe: DraftPreview;
} {
  return bothPreviews((lang) => ({
    action: actionText(input, lang),
    facts: facts(input, lang),
    warnings: warnings(input, lang),
    irreversible: false,
  }));
}

function customerName(input: TemplatePreviewInput): string {
  return cleanText(input.basics.contact.contact.displayName, NAME_MAX) ?? "(unnamed)";
}

function customerText(input: TemplatePreviewInput, lang: PreviewLanguage): string {
  const word = lang === "de" ? "Kontakt" : "contact";
  return `${customerName(input)} (${word} ${String(input.contactId)})`;
}

function actionText(input: TemplatePreviewInput, lang: PreviewLanguage): string {
  const { schedule, basics } = input;
  const gross = moneyText(basics.expected.gross, basics.currency, lang);
  const interval = INTERVALS[schedule.interval][lang];
  const start = dateText(schedule.startDate, lang);
  const end = schedule.endDate === undefined ? undefined : dateText(schedule.endDate, lang);
  if (lang === "de") {
    return (
      `Abo-Rechnung (Vorlage für wiederkehrende Rechnungen) für ${customerText(input, lang)} ` +
      `anlegen: ${gross} brutto je Rechnung, ${interval} ab ${start}` +
      `${end === undefined ? ", bis sie beendet wird" : ` bis ${end}`}.`
    );
  }
  return (
    `Create a recurring invoice template (Abo-Rechnung) for ${customerText(input, lang)}: ` +
    `${gross} gross per invoice, ${interval} from ${start}` +
    `${end === undefined ? " until it is ended" : ` to ${end}`}.`
  );
}

/** "monthly, every month on day 1 (P0Y1M0W)", "vierteljährlich, alle 3 Monate am 15. (P0Y3M0W)". */
function intervalText(schedule: Schedule, lang: PreviewLanguage): string {
  const { months, wire } = INTERVALS[schedule.interval];
  const day = String(schedule.runDay);
  const label = INTERVALS[schedule.interval][lang];
  if (lang === "de") {
    const every = months === 1 ? "jeden Monat" : `alle ${String(months)} Monate`;
    return `${label}, ${every} am ${day}. (${wire})`;
  }
  const every = months === 1 ? "every month" : `every ${String(months)} months`;
  return `${label}, ${every} on day ${day} (${wire})`;
}

/**
 * The end date with the number of runs up to it, or that there is none. When the last run falls on
 * the end date, whether sevDesk still makes it is not recorded ({@link endOnRunWarning}), so the
 * count is given as one fewer or that many.
 */
function endText(schedule: Schedule, lang: PreviewLanguage): string {
  const count = runCount(schedule);
  if (schedule.endDate === undefined || count === undefined) {
    return lang === "de"
      ? "keines (die Vorlage läuft, bis sie beendet wird)"
      : "none (the template runs until it is ended)";
  }
  const de = lang === "de";
  const end = dateText(schedule.endDate, lang);
  const plural = count === 1 ? "" : de ? "en" : "s";
  const runs = `${de ? "Ausführung" : "run"}${plural}`;
  if (!endsOnRun(schedule)) {
    return de
      ? `${end} (bis dahin ${String(count)} ${runs}, die erste eingeschlossen)`
      : `${end} (${String(count)} ${runs} up to then, the first included)`;
  }
  const range = `${String(count - 1)} ${de ? "oder" : "or"} ${String(count)} ${runs}`;
  const first = count > 1 ? (de ? ", die erste eingeschlossen" : ", the first included") : "";
  return de
    ? `${end} (bis dahin ${range}${first}: ${String(count)}, wenn sevDesk die Vorlage am ` +
        "Enddatum noch ausführt)"
    : `${end} (${range} up to then${first}: ${String(count)} if sevDesk still runs the ` +
        "template on its end date)";
}

function followingRunsText(schedule: Schedule, lang: PreviewLanguage): string {
  const following = runDates(schedule, FOLLOWING_RUNS + 1).slice(1);
  if (following.length === 0) {
    return lang === "de" ? "keine bis zum Enddatum" : "none before the end date";
  }
  return following.map((date) => dateText(date, lang)).join(", ");
}

function priceModeText(mode: PriceMode, lang: PreviewLanguage): string {
  if (lang === "en") return mode;
  return mode === "net" ? "netto" : "brutto";
}

/** "1 Umsatzsteuerpflichtige Umsätze", or the Update 1.0 tax type the rule became. */
function taxText(input: TemplatePreviewInput, lang: PreviewLanguage): string {
  const { rule, tax } = input.basics;
  if (!("taxType" in tax)) return taxRuleLabel(rule);
  return lang === "de"
    ? `Steuerart ${tax.taxType} (aus Steuerregel ${taxRuleLabel(rule)}), Buchhaltung 1.0`
    : `tax type ${tax.taxType} (from tax rule ${taxRuleLabel(rule)}), bookkeeping 1.0`;
}

/**
 * One position: "Beratung: 3 × 10.00 EUR net, 19 % VAT → net 30.00 EUR", then its text as given
 * on the next line. In German "3 × 10,00 EUR netto, 19 % USt. → netto 30,00 EUR".
 */
function positionText(
  position: DraftPosition,
  mode: PriceMode,
  currency: string,
  lang: PreviewLanguage,
): string {
  const de = lang === "de";
  const price = format(position.unitPrice, Math.max(2, decimal(position.unitPrice).scale));
  const net = positionAmounts(position, mode).net;
  const parts = [
    `${numberText(position.quantity, lang)} × ${moneyText(price, currency, lang)} ` +
      priceModeText(mode, lang),
    `${numberText(position.taxRate, lang)} % ${de ? "USt." : "VAT"}`,
    position.discountPercent === undefined
      ? undefined
      : `${numberText(position.discountPercent, lang)} % ${de ? "Rabatt" : "discount"}`,
    position.unitId === DEFAULT_UNIT_ID
      ? undefined
      : `${de ? "Einheit" : "unit"} ${String(position.unitId)}`,
    position.partId === undefined
      ? undefined
      : `${de ? "Artikel" : "part"} ${String(position.partId)}`,
  ].filter((part): part is string => part !== undefined);
  const line =
    `${position.name}: ${parts.join(", ")} → ` +
    `${de ? "netto" : "net"} ${moneyText(net, currency, lang)}`;
  return position.text === undefined ? line : `${line}\nText: ${position.text}`;
}

function facts(input: TemplatePreviewInput, lang: PreviewLanguage): PreviewFact[] {
  const t = LABELS[lang];
  const { basics, content, schedule } = input;
  const list: PreviewFact[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined && trimmedText(value) !== undefined) list.push({ label, value });
  };
  const person = basics.contactPerson;
  const user = lang === "de" ? "Benutzer" : "user";

  add(t.customer, customerText(input, lang));
  add(t.address, addressText(basics.address));
  add(t.interval, intervalText(schedule, lang));
  add(t.firstRun, dateText(schedule.startDate, lang));
  add(t.followingRuns, followingRunsText(schedule, lang));
  add(t.end, endText(schedule, lang));
  add(t.autoGenerate, AUTO_GENERATE_TEXT[switchState(input)][lang]);
  add(
    t.contactPerson,
    `${cleanText(person.name, NAME_MAX) ?? ""} (${user} ${String(person.id)})`.trim(),
  );
  add(t.title, content.header);
  add(
    t.paymentTerm,
    content.timeToPay === undefined
      ? undefined
      : `${String(content.timeToPay)} ${lang === "de" ? "Tage" : "days"}`,
  );
  add(t.priceMode, priceModeText(basics.mode, lang));
  add(t.taxRule, taxText(input, lang));
  add(t.taxNote, basics.tax.taxText);
  add(t.headText, content.headText);
  basics.positions.forEach((position, index) => {
    add(
      `${t.position} ${String(index + 1)}`,
      positionText(position, basics.mode, basics.currency, lang),
    );
  });
  add(t.footText, content.footText);
  add(t.total, totalsText(input, lang));
  return list;
}

function totalsText(input: TemplatePreviewInput, lang: PreviewLanguage): string {
  const { net, tax, gross } = input.basics.expected;
  const { currency } = input.basics;
  if (lang === "de") {
    return (
      `netto ${moneyText(net, currency, lang)}, USt. ${moneyText(tax, currency, lang)}, ` +
      `brutto ${moneyText(gross, currency, lang)}`
    );
  }
  return (
    `net ${moneyText(net, currency)}, tax ${moneyText(tax, currency)}, ` +
    `gross ${moneyText(gross, currency)}`
  );
}

function similarWarning(input: TemplatePreviewInput, lang: PreviewLanguage): string | undefined {
  const ids = input.similar;
  if (ids.length === 0) return undefined;
  const gross = moneyText(input.basics.expected.gross, input.basics.currency, lang);
  const list = ids.join(", ");
  const one = ids.length === 1;
  if (lang === "de") {
    return (
      `Mögliches Duplikat: ${one ? "Vorlage" : "Vorlagen"} ${list} für denselben Kunden mit ` +
      `derselben Bruttosumme (${gross}) ${one ? "besteht" : "bestehen"} bereits und ` +
      `${one ? "ist" : "sind"} nicht deaktiviert. Jede Vorlage stellt dem Kunden eigene ` +
      "Rechnungen."
    );
  }
  return (
    `Possible duplicate: ${one ? "template" : "templates"} ${list} for the same customer with ` +
    `the same gross total (${gross}) ${one ? "exists" : "exist"} already and ` +
    `${one ? "is" : "are"} not deactivated. Every template bills the customer on its own.`
  );
}

function endOnRunWarning(schedule: Schedule, lang: PreviewLanguage): string | undefined {
  const { endDate } = schedule;
  if (endDate === undefined || !endsOnRun(schedule)) return undefined;
  const end = dateText(endDate, lang);
  return lang === "de"
    ? `Eine Ausführung fällt genau auf das Enddatum (${end}); ob sevDesk die Vorlage am ` +
        "Enddatum selbst noch ausführt, ist nicht erfasst."
    : `A run falls on the end date itself (${end}); whether sevDesk still runs the template on ` +
        "its end date is not recorded.";
}

function switchState(input: TemplatePreviewInput): "on" | "off" {
  return input.autoGenerate ? "on" : "off";
}

/** Consequences first, then notes on the dates, a possible duplicate, and the tax rule. */
function warnings(input: TemplatePreviewInput, lang: PreviewLanguage): string[] {
  const { schedule, basics } = input;
  const list: (string | undefined)[] = [
    RUN_DATE_BEHAVIOUR[switchState(input)][lang],
    // What would turn the drafts into sent invoices: only relevant while sevDesk creates them.
    input.autoGenerate ? RUN_DATE_BEHAVIOUR.autoSending[lang] : undefined,
    HOW_TO_END[lang],
    input.autoGenerate && schedule.startDate === input.today ? FIRST_RUN_TODAY[lang] : undefined,
    endOnRunWarning(schedule, lang),
    similarWarning(input, lang),
    basics.regime === undefined
      ? lang === "de"
        ? UNKNOWN_REGIME_WARNING_DE
        : UNKNOWN_REGIME_WARNING
      : undefined,
    ...taxRuleWarnings(basics.rule, basics.regime, lang),
  ];
  return list.filter((warning): warning is string => warning !== undefined);
}
