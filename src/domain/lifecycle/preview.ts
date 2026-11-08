/**
 * Shared building blocks of the lifecycle confirmations: the facts that identify a document
 * (number, type, status, customer, dates, net/tax/gross with currency, paid so far) and how amounts
 * and documents are written in previews. Structurally the same as the tools' `ConfirmationFact`,
 * kept here so the domain does not depend on the tool layer.
 *
 * Values come from the M2 DTOs, whose upstream text (number, customer name) is already cleaned
 * with `cleanText`; labels and the remaining wording are ours.
 */
import { DEFAULT_CURRENCY, type Money, money } from "../money.js";
import { KINDS, type LifecycleDocument } from "./documents.js";

/** One labelled fact of a preview. */
export interface Fact {
  readonly label: string;
  readonly value: string;
}

/** `"1190.00 EUR"`: the exact amount and its currency. */
export function formatMoney(value: Money): string {
  return `${value.amount} ${value.currency}`;
}

/**
 * The document as an action sentence names it: "invoice RE-1001" or, without a number yet,
 * "invoice 1001 (no number yet)". The number is cleaned upstream text (from the DTO), assigned by
 * sevDesk's number range. A voucher is always named by its id ("voucher 2001"): its Belegnummer is
 * free text from the supplier's receipt (BT-1 on an e-invoice import), so it appears only as a
 * fact value ({@link documentFacts}), never in the action.
 */
export function documentTitle(doc: LifecycleDocument): string {
  const { noun } = KINDS[doc.kind];
  if (doc.kind === "voucher") return `${noun} ${String(doc.id)}`;
  return doc.number === undefined
    ? `${noun} ${String(doc.id)} (no number yet)`
    : `${noun} ${doc.number}`;
}

/**
 * The customer (or a voucher's supplier) as a fact value: "Musterfirma GmbH (contact 1001)",
 * "contact 1001", or a voucher's typed-in name without a contact: "Bürohaus (no contact)".
 */
function partyText(doc: LifecycleDocument): string | undefined {
  const contact = doc.contact;
  if (contact === undefined) {
    return doc.partyName === undefined ? undefined : `${doc.partyName} (no contact)`;
  }
  return contact.name === undefined
    ? `contact ${String(contact.id)}`
    : `${contact.name} (contact ${String(contact.id)})`;
}

/** "Customer" for sales documents and revenue vouchers, "Supplier (Lieferant)" for expenses. */
function partyLabel(doc: LifecycleDocument): string {
  if (doc.kind !== "voucher") return "Customer";
  return doc.direction === "out" ? "Supplier (Lieferant)" : "Customer (Kunde)";
}

/**
 * The facts that identify a document, most important first. Absent values are left out, so the
 * list (and with it the preview) only changes when the document does.
 */
export function documentFacts(doc: LifecycleDocument): Fact[] {
  const info = KINDS[doc.kind];
  const facts: Fact[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined) facts.push({ label, value });
  };
  const nounTitle = info.noun.charAt(0).toUpperCase() + info.noun.slice(1);
  add(
    `${nounTitle} (${info.nounDe})`,
    doc.number === undefined
      ? `id ${String(doc.id)}, ${info.noNumber}`
      : `${doc.number} (id ${String(doc.id)})`,
  );
  if (doc.typeCode !== undefined) {
    add("Type", doc.typeLabel === undefined ? doc.typeCode : `${doc.typeLabel} (${doc.typeCode})`);
  }
  add("Status", `${doc.statusLabel} (${String(doc.status)})`);
  if (doc.kind === "voucher" && doc.direction !== undefined) {
    add("Kind", doc.direction === "out" ? "expense (Ausgabe)" : "revenue (Einnahme)");
  }
  add(partyLabel(doc), partyText(doc));
  add("Date", doc.date);
  add("Due date", doc.dueDate);
  const { net, tax, gross } = doc.totals;
  add("Net", net === undefined ? undefined : formatMoney(net));
  add("Tax", tax === undefined ? undefined : formatMoney(tax));
  add("Gross", gross === undefined ? undefined : formatMoney(gross));
  const grossEur = doc.totalsEur?.gross;
  add(
    "Gross in EUR (booked by sevDesk)",
    grossEur === undefined ? undefined : formatMoney(grossEur),
  );
  // Shown for EUR documents only, as in the M2 DTOs: the currency of a foreign-currency
  // document's paidAmount is undocumented (spec/deviations.md D-043).
  add(
    "Paid so far",
    doc.paidAmount === undefined || doc.currency !== DEFAULT_CURRENCY
      ? undefined
      : formatMoney(money(doc.paidAmount, doc.currency)),
  );
  if (doc.enshrined) add("Enshrined", "yes (festgeschrieben)");
  return facts;
}
