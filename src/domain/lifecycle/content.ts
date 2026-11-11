/**
 * What finalize, send and enshrine make binding, read once and used twice: the approval binding
 * (a hash of the raw record and its raw positions) and the preview facts that show the same
 * content to the human who approves.
 *
 * Why both come from one read. Everything printed on a draft (head and foot text, the address
 * block, the positions, payment terms) can be written with the `write` tier, which asks nobody.
 * The binding alone only stops an edit made after the human was asked; an edit made before
 * (other bank details in the foot text, then "please finalize") was approved unseen, because the
 * preview showed number, customer, dates and totals only (review 2026-11, round 3). So the
 * preview lists the stored content, built from the very record and position rows the binding
 * hashes: what is shown and what is bound cannot differ.
 *
 * Texts are shown as stored: not trimmed, not cut, HTML tags left in. `displayPreview`
 * (`src/safety/preview.ts`) removes invisible characters wherever a preview is shown, and a human
 * sees at most 12,000 characters of one value, with an explicit marker after that. Absent values
 * are left out, so the facts (and the preview hash) change only when the document does. What the
 * facts cannot show without further reads is named in {@link DocumentContent.notShown}, a fixed
 * sentence per kind.
 */
import { z } from "zod";

import { canonicalJson, sha256Hex } from "../../safety/hashing.js";
import {
  parseUpstream,
  zBool01,
  zId,
  zOptionalDecimal,
  zOptionalInt,
  zOptionalRef,
  zText,
} from "../../sevdesk/schema.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import { moneyFromUpstream, splitTotals, trimmedText } from "../common.js";
import type { CreditNoteDetail } from "../credit-notes.js";
import type { InvoiceDetail } from "../invoices.js";
import { isDecimal, isZero, type Money } from "../money.js";
import type { OrderDetail } from "../orders.js";
import { type ChildRows, listChildRows } from "../paging.js";
import {
  dateText,
  numberText,
  type Phrase,
  phrase,
  type PreviewLanguage,
} from "../preview-text.js";
import type { VoucherDetailDto } from "../vouchers.js";
import { KINDS, type LifecycleDocument, type LifecycleKind } from "./documents.js";
import { documentFacts, type Fact, formatMoney } from "./preview.js";

/**
 * Positions listed one by one: as many as this server's draft tools write into one document
 * (`MAX_POSITIONS` in `drafts/positions.ts`; vouchers 50), so nothing a `write` tool stored goes
 * unlisted. A longer list (made in the web app) ends with a line that says how many are not
 * listed and how many there are.
 */
export const MAX_LISTED_POSITIONS = 100;

/** The content of a document for an approval. Both languages give the same facts in order. */
export interface DocumentContent {
  /** The approval binding (`WritePlan.binding`): SHA-256 of kind, raw record and raw positions. */
  readonly binding: string;
  /**
   * The identifying facts (`documentFacts`) with the address printed on the document right after
   * the customer.
   */
  readonly identity: (lang: PreviewLanguage) => Fact[];
  /** What else is stored and printed: title, dates, tax setting, texts, positions, terms. */
  readonly printed: (lang: PreviewLanguage) => Fact[];
  /** {@link identity} followed by {@link printed}. */
  readonly facts: (lang: PreviewLanguage) => Fact[];
  /** The fixed warning that names what the facts do not show. */
  readonly notShown: Phrase;
}

/** Where the positions of each kind live and how they point back to their document. */
const POSITIONS: Readonly<
  Record<LifecycleKind, { readonly path: string; readonly parentKey: string }>
> = {
  invoice: { path: "/InvoicePos", parentKey: "invoice" },
  creditNote: { path: "/CreditNotePos", parentKey: "creditNote" },
  order: { path: "/OrderPos", parentKey: "order" },
  voucher: { path: "/VoucherPos", parentKey: "voucher" },
};

/** The parent id a raw position row names (`<parentKey>.id`), as a string. */
function parentIdOf(row: unknown, parentKey: string): string | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const parent = (row as Record<string, unknown>)[parentKey];
  if (typeof parent !== "object" || parent === null) return undefined;
  const id = (parent as Record<string, unknown>)["id"];
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

/**
 * The approval binding of a lifecycle action (see `WritePlan.binding`): a SHA-256 of the record
 * as sevDesk sent it (full texts, exact `update` time) and of all its positions as stored, so a
 * document edited after the human was asked is asked about again instead of finalized, sent or
 * enshrined. The first version hashed the display DTO, which cuts long texts and keeps only the
 * date of `update`, and read no positions (security review 2026-11, wave 2). `complete` is hashed
 * too, so a list cut at the read cap is not mistaken for a complete one.
 */
function documentBinding(doc: LifecycleDocument, positions: ChildRows<unknown>): string {
  return sha256Hex(canonicalJson({ kind: doc.kind, record: doc.raw, positions }));
}

/**
 * Reads the positions of `doc` (one request; the record itself came with
 * `readLifecycleDocument`) and returns the binding and the content facts built from the same
 * data. A record or position row that does not fit is an `unexpected_response` error: nothing is
 * approved on content this server could not read.
 */
export async function readDocumentContent(
  client: SevdeskClient,
  doc: LifecycleDocument,
  signal?: AbortSignal,
): Promise<DocumentContent> {
  if (doc.raw === undefined) {
    throw new Error("readDocumentContent needs a document from readLifecycleDocument.");
  }
  const { path, parentKey } = POSITIONS[doc.kind];
  const id = String(doc.id);
  // The rows as sevDesk sent them (full texts), checked against their parent like every
  // position read.
  const positions = await listChildRows(
    client,
    path,
    { [`${parentKey}[id]`]: id, [`${parentKey}[objectName]`]: KINDS[doc.kind].objectName },
    { parse: (row) => row, belongs: (row) => parentIdOf(row, parentKey) === id },
    signal,
  );
  const binding = documentBinding(doc, positions);
  if (doc.kind === "voucher") {
    const rows = positions.rows.map((row) =>
      parseUpstream(voucherPositionSchema, row, "voucher positions"),
    );
    return content(
      binding,
      (lang) => documentFacts(doc, lang),
      (lang) => voucherFacts(doc, rows, positions.complete, lang),
      NOT_SHOWN.voucher,
    );
  }
  const record: PrintedRecord = parseUpstream(
    doc.kind === "order" ? printedOrderSchema : printedRecordSchema,
    doc.raw,
    `a ${KINDS[doc.kind].noun}`,
  );
  const rows = positions.rows
    .map((row) => parseUpstream(positionSchema, row, `${KINDS[doc.kind].noun} positions`))
    .sort(
      (a, b) =>
        (a.positionNumber ?? Number.MAX_SAFE_INTEGER) -
          (b.positionNumber ?? Number.MAX_SAFE_INTEGER) || a.id - b.id,
    );
  return content(
    binding,
    (lang) => documentFacts(doc, lang, addressFacts(record, TEXT[lang])),
    (lang) => salesFacts(doc, record, rows, positions.complete, lang),
    NOT_SHOWN[doc.kind],
  );
}

function content(
  binding: string,
  identity: (lang: PreviewLanguage) => Fact[],
  printed: (lang: PreviewLanguage) => Fact[],
  notShown: Phrase,
): DocumentContent {
  return {
    binding,
    identity,
    printed,
    facts: (lang) => [...identity(lang), ...printed(lang)],
    notShown,
  };
}

// ---------------------------------------------------------------------------------------------
// What is read from the raw record and rows
// ---------------------------------------------------------------------------------------------

/**
 * The long texts of a sales document, raw: the detail DTO caps them (2,000 characters, the tax
 * note 200), and an approval must show what is stored.
 */
const printedTexts = {
  header: zText,
  headText: zText,
  footText: zText,
  address: zText,
  addressName: zText,
  addressStreet: zText,
  addressZip: zText,
  addressCity: zText,
  taxText: zText,
};

const printedRecordSchema = z.object(printedTexts);

/** Orders also print their payment and delivery terms; the other kinds have no such fields. */
const printedOrderSchema = z.object({
  ...printedTexts,
  paymentTerms: zText,
  deliveryTerms: zText,
});

type PrintedRecord = z.output<typeof printedRecordSchema> &
  Partial<z.output<typeof printedOrderSchema>>;

/** A position row of an invoice, credit note or order (the fields `document-positions.ts` reads). */
const positionSchema = z.object({
  id: zId,
  positionNumber: zOptionalInt,
  name: zText,
  text: zText,
  quantity: zOptionalDecimal,
  price: zOptionalDecimal,
  priceNet: zOptionalDecimal,
  priceGross: zOptionalDecimal,
  taxRate: zOptionalDecimal,
  discount: zOptionalDecimal,
  isPercentage: zBool01.optional(),
  optional: zBool01.optional(),
  sumNet: zOptionalDecimal,
  sumTax: zOptionalDecimal,
  sumGross: zOptionalDecimal,
  sumNetForeignCurrency: zOptionalDecimal,
  sumTaxForeignCurrency: zOptionalDecimal,
  sumGrossForeignCurrency: zOptionalDecimal,
});

type Position = z.output<typeof positionSchema>;

/** A voucher position row (Belegposition). */
const voucherPositionSchema = z.object({
  id: zId,
  accountDatev: zOptionalRef,
  accountingType: zOptionalRef,
  taxRate: zOptionalDecimal,
  comment: zText,
  isAsset: zBool01.optional(),
  sumNet: zOptionalDecimal,
  sumTax: zOptionalDecimal,
  sumGross: zOptionalDecimal,
  sumNetForeignCurrency: zOptionalDecimal,
  sumTaxForeignCurrency: zOptionalDecimal,
  sumGrossForeignCurrency: zOptionalDecimal,
});

type VoucherPosition = z.output<typeof voucherPositionSchema>;

// ---------------------------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------------------------

const TEXT = {
  en: {
    address: "Address on the document",
    addressFields: "Address fields (structured)",
    title: "Title on the document (Betreff)",
    delivery: "Delivery date or period (Leistungsdatum)",
    cashDiscount: "Cash discount (Skonto)",
    taxRule: "Tax rule (Steuerregel)",
    taxType: "Tax type (Update 1.0)",
    taxNote: "Tax note (Steuerhinweis)",
    bookingCategory: "Booking category (Buchungskategorie)",
    sourceInvoice: "Reduces invoice",
    headText: "Head text (Kopftext)",
    footText: "Foot text (Fußtext)",
    paymentTerms: "Payment terms (Zahlungsbedingungen)",
    deliveryTerms: "Delivery terms (Lieferbedingungen)",
    positions: "Positions",
    none: "none",
    position: "Position",
    more: "More positions",
    noName: "(no name)",
    net: "net",
    gross: "gross",
    vat: "VAT",
    discount: "discount",
    optional: "optional (not in the total)",
    text: "Text",
    id: "id",
    account: "booking account (Buchungskonto) id",
    legacyAccount: "booking account (Update 1.0) id",
    asset: "asset (Anlagegut)",
    receipt: "Receipt file (Belegdatei)",
    receiptYes: "attached (its content is not shown here)",
    receiptNo: "none attached",
  },
  de: {
    address: "Anschrift auf dem Dokument",
    addressFields: "Adressfelder (strukturiert)",
    title: "Betreff auf dem Dokument",
    delivery: "Leistungsdatum oder -zeitraum",
    cashDiscount: "Skonto",
    taxRule: "Steuerregel",
    taxType: "Steuerart (Update 1.0)",
    taxNote: "Steuerhinweis",
    bookingCategory: "Buchungskategorie",
    sourceInvoice: "Mindert Rechnung",
    headText: "Kopftext",
    footText: "Fußtext",
    paymentTerms: "Zahlungsbedingungen",
    deliveryTerms: "Lieferbedingungen",
    positions: "Positionen",
    none: "keine",
    position: "Position",
    more: "Weitere Positionen",
    noName: "(ohne Bezeichnung)",
    net: "netto",
    gross: "brutto",
    vat: "USt.",
    discount: "Rabatt",
    optional: "optional (nicht in der Summe)",
    text: "Text",
    id: "ID",
    account: "Buchungskonto-ID",
    legacyAccount: "Buchungskonto-ID (Update 1.0)",
    asset: "Anlagegut",
    receipt: "Belegdatei",
    receiptYes: "angehängt (ihr Inhalt wird hier nicht gezeigt)",
    receiptNo: "keine angehängt",
  },
} as const;

type Wording = (typeof TEXT)[PreviewLanguage];

/** German names of the credit note booking categories; the English ones come with the DTO. */
const BOOKING_CATEGORY_DE: Readonly<Record<string, string>> = {
  UNDERACHIEVEMENT: "Minderleistung einer Rechnung oder eines Belegs",
  PROVISION: "Provision",
  ROYALTY_ASSIGNED: "Lizenzgebühr, zugeordnet",
  ROYALTY_UNASSIGNED: "Lizenzgebühr, nicht zugeordnet",
  ACCOUNTING_TYPE: "Buchung auf ein Sonderkonto (nur Update 1.0)",
};

/** What the facts of a sales document leave out, with the tool that shows it. */
function salesNotShown(pdfTool: string): Phrase {
  return phrase(
    "The facts list the stored texts, the address and the positions. Not shown: the contact " +
      "person (Ansprechpartner), the country of the address, the units and linked articles of " +
      `the positions, and the layout of the PDF. Check ${pdfTool} if they matter.`,
    "Die Angaben nennen die gespeicherten Texte, die Anschrift und die Positionen. Nicht " +
      "gezeigt werden: der Ansprechpartner, das Land der Anschrift, die Einheiten und " +
      `verknüpften Artikel der Positionen sowie das Layout des PDF. Prüfen Sie bei Bedarf ` +
      `${pdfTool}.`,
  );
}

const NOT_SHOWN: Readonly<Record<LifecycleKind, Phrase>> = {
  invoice: salesNotShown("sevdesk_invoice_pdf"),
  creditNote: salesNotShown("sevdesk_credit_note_pdf"),
  order: salesNotShown("sevdesk_order_pdf"),
  voucher: phrase(
    "The facts list the stored positions. Not shown: the names of the booking accounts (only " +
      "their ids) and the content of the attached receipt file. Check sevdesk_voucher_get and " +
      "the receipt if they matter.",
    "Die Angaben nennen die gespeicherten Positionen. Nicht gezeigt werden: die Namen der " +
      "Buchungskonten (nur ihre IDs) und der Inhalt der angehängten Belegdatei. Prüfen Sie bei " +
      "Bedarf sevdesk_voucher_get und den Beleg.",
  ),
};

// ---------------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------------

/** Adds a fact unless its value is absent or blank. The value itself is kept as stored. */
function push(facts: Fact[], label: string, value: string | undefined): void {
  if (value !== undefined && trimmedText(value) !== undefined) facts.push({ label, value });
}

/**
 * The tax setting: the Update 2.0 rule with its German name from reference data, else the legacy
 * tax type (both from the detail DTO, short and already cleaned).
 */
function pushTax(
  facts: Fact[],
  tax: {
    readonly rule?: { readonly id: number; readonly name?: string | undefined } | undefined;
    readonly taxType?: string | undefined;
  },
  t: Wording,
): void {
  const { rule } = tax;
  if (rule === undefined) {
    push(facts, t.taxType, tax.taxType);
    return;
  }
  push(facts, t.taxRule, rule.name === undefined ? String(rule.id) : `${rule.id} ${rule.name}`);
}

/** `from` or `from – until` in the language's date notation. */
function periodText(
  from: string | undefined,
  until: string | undefined,
  lang: PreviewLanguage,
): string | undefined {
  if (from !== undefined && (until === undefined || until === from)) return dateText(from, lang);
  if (until === undefined) return undefined;
  return `${from === undefined ? "?" : dateText(from, lang)} – ${dateText(until, lang)}`;
}

/** The structured address parts as printed lines: name, street, "zip city". */
function structuredAddress(record: PrintedRecord): string | undefined {
  const place = [record.addressZip, record.addressCity]
    .filter((part) => trimmedText(part) !== undefined)
    .join(" ");
  const lines = [record.addressName, record.addressStreet, place].filter(
    (line): line is string => trimmedText(line) !== undefined,
  );
  return lines.length === 0 ? undefined : lines.join("\n");
}

/** Line breaks and surrounding space removed, for comparing two spellings of one address. */
function folded(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/**
 * The address block: the stored `address` text, else the structured parts sevDesk composes it
 * from (API-created documents often carry only those). When both are stored and differ, both
 * are shown: which one sevDesk prints is not documented.
 */
function addressFacts(record: PrintedRecord, t: Wording): Fact[] {
  const facts: Fact[] = [];
  const parts = structuredAddress(record);
  if (trimmedText(record.address) === undefined) {
    push(facts, t.address, parts);
    return facts;
  }
  push(facts, t.address, record.address);
  if (parts !== undefined && folded(parts) !== folded(record.address ?? "")) {
    push(facts, t.addressFields, parts);
  }
  return facts;
}

/** A sevDesk amount as money text; `undefined` when sevDesk sent none. */
function amountText(
  amount: string | undefined,
  currency: string,
  lang: PreviewLanguage,
): string | undefined {
  const value = moneyFromUpstream(amount, currency);
  return value === undefined ? undefined : formatMoney(value, lang);
}

function nonZero(value: string | undefined): string | undefined {
  return value === undefined || (isDecimal(value) && isZero(value)) ? undefined : value;
}

/** "100.00 EUR net, 119.00 EUR gross" of a row's sums, whichever sevDesk sent. */
function sumsText(
  totals: { readonly net?: Money | undefined; readonly gross?: Money | undefined },
  t: Wording,
  lang: PreviewLanguage,
): string | undefined {
  const parts = [
    totals.net === undefined ? undefined : `${formatMoney(totals.net, lang)} ${t.net}`,
    totals.gross === undefined ? undefined : `${formatMoney(totals.gross, lang)} ${t.gross}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(", ");
}

/**
 * One position: "Beratung: 2 × 49.90 EUR net, 19 % VAT, 10 % discount → 89.82 EUR net,
 * 106.89 EUR gross", then its text as stored on the lines below. The name is folded onto one
 * line; the unit price is sevDesk's `price`, net or gross as the document's price mode says.
 */
function positionText(
  row: Position,
  doc: LifecycleDocument,
  priceMode: "net" | "gross" | undefined,
  lang: PreviewLanguage,
): string {
  const t = TEXT[lang];
  const name = row.name === undefined ? "" : folded(row.name);
  const mode = row.price !== undefined ? priceMode : row.priceNet !== undefined ? "net" : "gross";
  const price = amountText(row.price ?? row.priceNet ?? row.priceGross, doc.currency, lang);
  const amount =
    row.quantity === undefined && price === undefined
      ? undefined
      : `${row.quantity === undefined ? "?" : numberText(row.quantity, lang)} × ` +
        `${price ?? "?"}${price === undefined || mode === undefined ? "" : ` ${t[mode]}`}`;
  const discount = nonZero(row.discount);
  const parts = [
    amount,
    row.taxRate === undefined ? undefined : `${numberText(row.taxRate, lang)} % ${t.vat}`,
    discount === undefined
      ? undefined
      : row.isPercentage === false
        ? `${amountText(discount, doc.currency, lang) ?? discount} ${t.discount}`
        : `${numberText(discount, lang)}${row.isPercentage === true ? " %" : ""} ${t.discount}`,
    row.optional === true ? t.optional : undefined,
  ].filter((part): part is string => part !== undefined);
  const sums = sumsText(splitTotals(row, doc.currency).totals, t, lang);
  const line =
    `${name === "" ? t.noName : name}: ${parts.join(", ")}` +
    (sums === undefined ? "" : ` → ${sums}`);
  return trimmedText(row.text) === undefined ? line : `${line}\n${t.text}: ${row.text ?? ""}`;
}

/**
 * The position facts: one per position up to {@link MAX_LISTED_POSITIONS}, then a line with the
 * number not listed and the total. A list sevDesk did not return completely says so.
 */
function listedPositions<T>(
  rows: readonly T[],
  complete: boolean,
  lang: PreviewLanguage,
  text: (row: T) => string,
): Fact[] {
  const t = TEXT[lang];
  if (rows.length === 0 && complete) return [{ label: t.positions, value: t.none }];
  const facts = rows.slice(0, MAX_LISTED_POSITIONS).map((row, index) => ({
    label: `${t.position} ${String(index + 1)}`,
    value: text(row),
  }));
  const rest = rows.length - facts.length;
  const total = String(rows.length);
  const listed = String(facts.length);
  if (!complete) {
    // The read stopped at its cap (`listChildRows`): how many positions there are is unknown.
    facts.push({
      label: t.more,
      value:
        lang === "de"
          ? `sevDesk hat nicht alle Positionen geliefert: ${total} wurden gelesen, ${listed} ` +
            "sind hier aufgeführt, und es gibt weitere. Prüfen Sie sie vor der Freigabe in sevDesk."
          : `sevDesk did not return every position: ${total} were read, ${listed} are listed ` +
            "here, and there are more. Check them in sevDesk before you approve.",
    });
  } else if (rest > 0) {
    facts.push({
      label: t.more,
      value:
        lang === "de"
          ? `${String(rest)} weitere Positionen sind hier nicht aufgeführt (insgesamt ${total}). ` +
            "Prüfen Sie sie vor der Freigabe in sevDesk."
          : `${String(rest)} more positions are not listed here (${total} in total). Check ` +
            "them in sevDesk before you approve.",
    });
  }
  return facts;
}

type SalesDetail = InvoiceDetail | CreditNoteDetail | OrderDetail;

/** The printed content of an invoice, credit note or order: terms, texts, positions. */
function salesFacts(
  doc: LifecycleDocument,
  record: PrintedRecord,
  rows: readonly Position[],
  complete: boolean,
  lang: PreviewLanguage,
): Fact[] {
  const t = TEXT[lang];
  const detail = doc.dto as SalesDetail;
  const facts: Fact[] = [];
  push(facts, t.title, record.header);
  push(
    facts,
    t.delivery,
    periodText(
      detail.deliveryDate,
      "deliveryDateUntil" in detail ? detail.deliveryDateUntil : undefined,
      lang,
    ),
  );
  if (doc.kind === "invoice") {
    const terms = (doc.dto as InvoiceDetail).paymentTerms;
    const percent = terms?.cashDiscountPercent;
    if (percent !== undefined) {
      const days = terms?.cashDiscountDays;
      const within =
        days === undefined
          ? ""
          : lang === "de"
            ? ` innerhalb von ${String(days)} Tagen`
            : ` within ${String(days)} days`;
      push(facts, t.cashDiscount, `${numberText(percent, lang)} %${within}`);
    }
  }
  pushTax(facts, detail.tax, t);
  push(facts, t.taxNote, record.taxText);
  if (doc.kind === "creditNote") {
    const creditNote = doc.dto as CreditNoteDetail;
    const category = creditNote.bookingCategory;
    if (category !== undefined) {
      const label = lang === "de" ? BOOKING_CATEGORY_DE[category.code] : category.label;
      push(
        facts,
        t.bookingCategory,
        label === undefined || label === "unknown" ? category.code : `${label} (${category.code})`,
      );
    }
    if (creditNote.sourceInvoiceId !== undefined) {
      push(facts, t.sourceInvoice, `${t.id} ${String(creditNote.sourceInvoiceId)}`);
    }
  }
  push(facts, t.headText, record.headText);
  facts.push(
    ...listedPositions(rows, complete, lang, (row) =>
      positionText(row, doc, detail.priceMode, lang),
    ),
  );
  push(facts, t.footText, record.footText);
  if (doc.kind === "order") {
    push(facts, t.paymentTerms, record.paymentTerms);
    push(facts, t.deliveryTerms, record.deliveryTerms);
  }
  return facts;
}

/** One voucher position: its sums, rate and booking account, then the comment as stored. */
function voucherPositionText(
  row: VoucherPosition,
  doc: LifecycleDocument,
  lang: PreviewLanguage,
): string {
  const t = TEXT[lang];
  const parts = [
    sumsText(splitTotals(row, doc.currency).totals, t, lang),
    row.taxRate === undefined ? undefined : `${numberText(row.taxRate, lang)} % ${t.vat}`,
    row.accountDatev !== undefined
      ? `${t.account} ${String(row.accountDatev.id)}`
      : row.accountingType === undefined
        ? undefined
        : `${t.legacyAccount} ${String(row.accountingType.id)}`,
    row.isAsset === true ? t.asset : undefined,
  ].filter((part): part is string => part !== undefined);
  const line = parts.join(", ");
  return trimmedText(row.comment) === undefined ? line : `${line}\n${t.text}: ${row.comment ?? ""}`;
}

/** The content of a voucher: service period, tax rule, positions, receipt file. */
function voucherFacts(
  doc: LifecycleDocument,
  rows: readonly VoucherPosition[],
  complete: boolean,
  lang: PreviewLanguage,
): Fact[] {
  const t = TEXT[lang];
  const detail = doc.dto as VoucherDetailDto;
  const facts: Fact[] = [];
  push(facts, t.delivery, periodText(detail.deliveryDate, detail.deliveryDateUntil, lang));
  pushTax(facts, detail.tax, t);
  facts.push(
    ...listedPositions(
      [...rows].sort((a, b) => a.id - b.id),
      complete,
      lang,
      (row) => voucherPositionText(row, doc, lang),
    ),
  );
  if (detail.hasDocument !== undefined) {
    push(facts, t.receipt, detail.hasDocument ? t.receiptYes : t.receiptNo);
  }
  return facts;
}
