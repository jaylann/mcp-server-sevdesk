/**
 * Shared building blocks of the lifecycle confirmations: the facts that identify a document
 * (number, type, status, customer, dates, net/tax/gross with currency, paid so far) and how amounts
 * and documents are written in previews. Structurally the same as the tools' `ConfirmationFact`,
 * kept here so the domain does not depend on the tool layer.
 *
 * Values come from the M2 DTOs, whose upstream text (number, customer name) is already cleaned
 * with `cleanText`; labels and the remaining wording are ours. Every helper takes the preview
 * language (`../preview-text.ts`); English is the default.
 */
import { DEFAULT_CURRENCY, type Money, money } from "../money.js";
import { dateText, numberText, type PreviewLanguage } from "../preview-text.js";
import { statusByCode } from "../reference-data.js";
import {
  KINDS,
  type LifecycleDocument,
  type LifecycleKind,
  type PaymentDirection,
} from "./documents.js";

/** One labelled fact of a preview. */
export interface Fact {
  readonly label: string;
  readonly value: string;
}

/** `"1190.00 EUR"`, in German `"1.190,00 EUR"`: the exact amount and its currency. */
export function formatMoney(value: Money, lang: PreviewLanguage = "en"): string {
  return `${numberText(value.amount, lang)} ${value.currency}`;
}

/** How German sentences name a document kind. */
interface GermanKind {
  /** "die Rechnung", "der Beleg". */
  readonly nominative: string;
  /** "die Rechnung", "den Beleg". */
  readonly accusative: string;
  /** "der Rechnung", "dem Beleg". */
  readonly dative: string;
  /** "diese Rechnung", "dieser Beleg". */
  readonly thisOne: string;
  /** "dieser Rechnung", "diesem Beleg". */
  readonly thisOneDative: string;
}

/** The document kinds in German sentences (the bare noun is `KINDS[kind].nounDe`). */
export const KIND_DE: Readonly<Record<LifecycleKind, GermanKind>> = {
  invoice: {
    nominative: "die Rechnung",
    accusative: "die Rechnung",
    dative: "der Rechnung",
    thisOne: "diese Rechnung",
    thisOneDative: "dieser Rechnung",
  },
  creditNote: {
    nominative: "die Gutschrift",
    accusative: "die Gutschrift",
    dative: "der Gutschrift",
    thisOne: "diese Gutschrift",
    thisOneDative: "dieser Gutschrift",
  },
  order: {
    nominative: "der Auftrag",
    accusative: "den Auftrag",
    dative: "dem Auftrag",
    thisOne: "dieser Auftrag",
    thisOneDative: "diesem Auftrag",
  },
  voucher: {
    nominative: "der Beleg",
    accusative: "den Beleg",
    dative: "dem Beleg",
    thisOne: "dieser Beleg",
    thisOneDative: "diesem Beleg",
  },
};

/** The kind's noun in `lang`: "credit note", "Gutschrift". */
export function kindNoun(kind: LifecycleKind, lang: PreviewLanguage = "en"): string {
  return lang === "de" ? KINDS[kind].nounDe : KINDS[kind].noun;
}

/**
 * The document as an action sentence names it: "invoice RE-1001" or, without a number yet,
 * "invoice 1001 (no number yet)"; in German "Rechnung RE-1001". The number is cleaned upstream
 * text (from the DTO), assigned by sevDesk's number range. A voucher is always named by its id
 * ("voucher 2001"): its Belegnummer is free text from the supplier's receipt (BT-1 on an
 * e-invoice import), so it appears only as a fact value ({@link documentFacts}), never in the
 * action.
 */
export function documentTitle(doc: LifecycleDocument, lang: PreviewLanguage = "en"): string {
  const noun = kindNoun(doc.kind, lang);
  if (doc.kind === "voucher") return `${noun} ${String(doc.id)}`;
  if (doc.number !== undefined) return `${noun} ${doc.number}`;
  return `${noun} ${String(doc.id)} (${lang === "de" ? "noch ohne Nummer" : "no number yet"})`;
}

/**
 * The status as a fact value: the label of sevDesk's documentation in English ("Open / due"), the
 * web app's term in German ("Offen / fällig"), with the code.
 */
export function statusText(doc: LifecycleDocument, lang: PreviewLanguage = "en"): string {
  return `${statusName(doc, lang)} (${String(doc.status)})`;
}

/** The status label alone (see {@link statusText}). */
export function statusName(doc: LifecycleDocument, lang: PreviewLanguage = "en"): string {
  if (lang === "en") return doc.statusLabel;
  return statusByCode(doc.kind, doc.status)?.labelDe ?? "unbekannt";
}

/** A bank transaction's status as a fact value, like {@link statusText}. */
export function transactionStatusText(
  status: { readonly code: number; readonly label: string },
  lang: PreviewLanguage = "en",
): string {
  const label =
    lang === "en"
      ? status.label
      : (statusByCode("transaction", status.code)?.labelDe ?? "unbekannt");
  return `${label} (${String(status.code)})`;
}

/**
 * The customer (or a voucher's supplier) as a fact value: "Musterfirma GmbH (contact 1001)",
 * "contact 1001", or a voucher's typed-in name without a contact: "Bürohaus (no contact)".
 */
function partyText(doc: LifecycleDocument, lang: PreviewLanguage): string | undefined {
  const contact = doc.contact;
  const word = lang === "de" ? "Kontakt" : "contact";
  if (contact === undefined) {
    if (doc.partyName === undefined) return undefined;
    return `${doc.partyName} (${lang === "de" ? "kein Kontakt" : "no contact"})`;
  }
  return contact.name === undefined
    ? `${word} ${String(contact.id)}`
    : `${contact.name} (${word} ${String(contact.id)})`;
}

/** "Customer" for sales documents and revenue vouchers, "Supplier (Lieferant)" for expenses. */
function partyLabel(doc: LifecycleDocument, lang: PreviewLanguage): string {
  const supplier = doc.kind === "voucher" && doc.direction === "out";
  if (lang === "de") return supplier ? "Lieferant" : "Kunde";
  if (doc.kind !== "voucher") return "Customer";
  return supplier ? "Supplier (Lieferant)" : "Customer (Kunde)";
}

/** A voucher's direction as a fact value: expense or revenue. */
function directionText(direction: PaymentDirection, lang: PreviewLanguage): string {
  if (lang === "de") return direction === "out" ? "Ausgabe" : "Einnahme";
  return direction === "out" ? "expense (Ausgabe)" : "revenue (Einnahme)";
}

/** The fact labels of {@link documentFacts}, per language. */
const LABELS = {
  en: {
    type: "Type",
    status: "Status",
    kind: "Kind",
    date: "Date",
    dueDate: "Due date",
    net: "Net",
    tax: "Tax",
    gross: "Gross",
    grossEur: "Gross in EUR (booked by sevDesk)",
    paid: "Paid so far",
    enshrined: "Enshrined",
    enshrinedYes: "yes (festgeschrieben)",
  },
  de: {
    type: "Typ",
    status: "Status",
    kind: "Art",
    date: "Datum",
    dueDate: "Fällig am",
    net: "Netto",
    tax: "Umsatzsteuer",
    gross: "Brutto",
    grossEur: "Brutto in EUR (so bucht es sevDesk)",
    paid: "Bisher bezahlt",
    enshrined: "Festgeschrieben",
    enshrinedYes: "ja",
  },
} as const;

/**
 * The facts that identify a document, most important first. Absent values are left out, so the
 * list (and with it the preview) only changes when the document does. Both languages give the
 * same facts in the same order.
 */
export function documentFacts(doc: LifecycleDocument, lang: PreviewLanguage = "en"): Fact[] {
  const info = KINDS[doc.kind];
  const t = LABELS[lang];
  const german = lang === "de";
  const facts: Fact[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined) facts.push({ label, value });
  };
  const nounTitle = info.noun.charAt(0).toUpperCase() + info.noun.slice(1);
  const id = `${german ? "ID" : "id"} ${String(doc.id)}`;
  const noNumber = german
    ? doc.kind === "voucher"
      ? "ohne Belegnummer"
      : "noch ohne Nummer"
    : info.noNumber;
  add(
    german ? info.nounDe : `${nounTitle} (${info.nounDe})`,
    doc.number === undefined ? `${id}, ${noNumber}` : `${doc.number} (${id})`,
  );
  if (doc.typeCode !== undefined) {
    add(t.type, doc.typeLabel === undefined ? doc.typeCode : `${doc.typeLabel} (${doc.typeCode})`);
  }
  add(t.status, statusText(doc, lang));
  if (doc.kind === "voucher" && doc.direction !== undefined) {
    add(t.kind, directionText(doc.direction, lang));
  }
  add(partyLabel(doc, lang), partyText(doc, lang));
  add(t.date, doc.date === undefined ? undefined : dateText(doc.date, lang));
  add(t.dueDate, doc.dueDate === undefined ? undefined : dateText(doc.dueDate, lang));
  const { net, tax, gross } = doc.totals;
  add(t.net, net === undefined ? undefined : formatMoney(net, lang));
  add(t.tax, tax === undefined ? undefined : formatMoney(tax, lang));
  add(t.gross, gross === undefined ? undefined : formatMoney(gross, lang));
  const grossEur = doc.totalsEur?.gross;
  add(t.grossEur, grossEur === undefined ? undefined : formatMoney(grossEur, lang));
  // Shown for EUR documents only, as in the M2 DTOs: the currency of a foreign-currency
  // document's paidAmount is undocumented (spec/deviations.md D-043).
  add(
    t.paid,
    doc.paidAmount === undefined || doc.currency !== DEFAULT_CURRENCY
      ? undefined
      : formatMoney(money(doc.paidAmount, doc.currency), lang),
  );
  if (doc.enshrined) add(t.enshrined, t.enshrinedYes);
  return facts;
}
