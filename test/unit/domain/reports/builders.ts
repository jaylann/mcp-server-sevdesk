/**
 * Raw sevDesk rows for the tax report tests (VAT summary, profit and loss, positions scan):
 * documents built from the community list fixtures (recorded key sets and scalar types) via the
 * M2 report helpers, plus position rows and fake-client routes per document.
 */
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { creditNoteRow, embeddedContact, invoice, voucher } from "../../tools/reports/records.js";

type Raw = Record<string, unknown>;

/** sevDesk's ISO date-time at 00:00 Berlin for a day (good enough for CET/CEST tests). */
function day(date: string): string {
  const month = Number(date.slice(5, 7));
  const summer = month >= 4 && month <= 10;
  return `${date}T00:00:00${summer ? "+02:00" : "+01:00"}`;
}

export interface DocumentSpec {
  readonly id: number;
  readonly date: string;
  readonly delivery?: string | null;
  readonly deliveryUntil?: string | null;
  readonly rule?: number | null;
  readonly status?: string;
  readonly net: string;
  readonly tax: string;
  readonly gross?: string;
  readonly currency?: string;
  /** Foreign currency: the document's own sums (the plain sums are then EUR). */
  readonly foreign?: { readonly net: string; readonly tax: string; readonly gross: string };
  readonly contactId?: number;
  readonly vatNumber?: string | null;
  /** `false`: a plain contact reference instead of an embedded contact. */
  readonly embed?: boolean;
  readonly countryId?: number;
  readonly payDate?: string | null;
}

function sums(spec: DocumentSpec): Raw {
  const gross = spec.gross ?? addStrings(spec.net, spec.tax);
  return {
    currency: spec.currency ?? "EUR",
    sumNet: spec.net,
    sumTax: spec.tax,
    sumGross: gross,
    sumNetForeignCurrency: spec.foreign?.net ?? "0",
    sumTaxForeignCurrency: spec.foreign?.tax ?? "0",
    sumGrossForeignCurrency: spec.foreign?.gross ?? "0",
  };
}

function addStrings(a: string, b: string): string {
  return String(Math.round((Number(a) + Number(b)) * 100) / 100);
}

function contactOf(spec: DocumentSpec): Raw {
  const id = String(spec.contactId ?? 1001);
  if (spec.embed === false) return { id, objectName: "Contact" };
  return { ...embeddedContact(id, "Musterfirma GmbH"), vatNumber: spec.vatNumber ?? null };
}

/** A `GET /Invoice` row (type RE unless overridden). */
export function invoiceDoc(spec: DocumentSpec, extra: Raw = {}): Raw {
  return invoice({
    id: String(spec.id),
    invoiceNumber: `RE-${String(spec.id)}`,
    invoiceDate: day(spec.date),
    deliveryDate: spec.delivery === null ? null : day(spec.delivery ?? spec.date),
    deliveryDateUntil: spec.deliveryUntil == null ? null : day(spec.deliveryUntil),
    status: spec.status ?? "200",
    taxRule: spec.rule === null ? null : { id: String(spec.rule ?? 1), objectName: "TaxRule" },
    contact: contactOf(spec),
    addressCountry:
      spec.countryId === undefined
        ? undefined
        : { id: String(spec.countryId), objectName: "StaticCountry" },
    payDate: spec.payDate == null ? null : day(spec.payDate),
    ...sums(spec),
    ...extra,
  });
}

/** A `GET /CreditNote` row. */
export function creditNoteDoc(spec: DocumentSpec, extra: Raw = {}): Raw {
  return creditNoteRow({
    id: String(spec.id),
    creditNoteNumber: `GU-${String(spec.id)}`,
    creditNoteDate: day(spec.date),
    deliveryDate: spec.delivery === null ? null : day(spec.delivery ?? spec.date),
    status: spec.status ?? "200",
    taxRule: spec.rule === null ? null : { id: String(spec.rule ?? 1), objectName: "TaxRule" },
    contact: contactOf(spec),
    ...sums(spec),
    ...extra,
  });
}

/** A `GET /Voucher` row; `kind` C expense (default) or D revenue. */
export function voucherDoc(
  spec: DocumentSpec & { readonly kind?: "C" | "D" },
  extra: Raw = {},
): Raw {
  return voucher({
    id: String(spec.id),
    description: `B-${String(spec.id)}`,
    voucherDate: day(spec.date),
    deliveryDate: spec.delivery === null ? null : day(spec.delivery ?? spec.date),
    deliveryDateUntil: spec.deliveryUntil == null ? null : day(spec.deliveryUntil),
    status: spec.status ?? "100",
    creditDebit: spec.kind ?? "C",
    taxRule: spec.rule === null ? null : { id: String(spec.rule ?? 9), objectName: "TaxRule" },
    supplier: { id: String(spec.contactId ?? 1003), objectName: "Contact" },
    payDate: spec.payDate == null ? null : day(spec.payDate),
    ...sums(spec),
    ...extra,
  });
}

export interface PositionSpec {
  readonly rate: string;
  readonly net: string;
  readonly tax: string;
  readonly gross?: string;
  readonly foreign?: { readonly net: string; readonly tax: string; readonly gross: string };
  readonly account?: number;
  readonly asset?: boolean;
  readonly optional?: boolean;
}

function positionSums(spec: PositionSpec): Raw {
  return {
    taxRate: spec.rate,
    sumNet: spec.net,
    sumTax: spec.tax,
    sumGross: spec.gross ?? addStrings(spec.net, spec.tax),
    sumNetForeignCurrency: spec.foreign?.net ?? "0",
    sumTaxForeignCurrency: spec.foreign?.tax ?? "0",
    sumGrossForeignCurrency: spec.foreign?.gross ?? "0",
  };
}

let positionId = 90_000;

/** `GET /InvoicePos` rows of one invoice. */
export function invoicePositions(invoiceId: number, positions: readonly PositionSpec[]): Raw[] {
  return positions.map((spec) => ({
    id: String((positionId += 1)),
    objectName: "InvoicePos",
    invoice: { id: String(invoiceId), objectName: "Invoice" },
    quantity: "1",
    price: spec.net,
    name: "Leistung",
    optional: spec.optional === true ? "1" : "0",
    ...positionSums(spec),
  }));
}

/** `GET /CreditNotePos` rows of one credit note. */
export function creditNotePositions(
  creditNoteId: number,
  positions: readonly PositionSpec[],
): Raw[] {
  return positions.map((spec) => ({
    id: String((positionId += 1)),
    objectName: "CreditNotePos",
    creditNote: { id: String(creditNoteId), objectName: "CreditNote" },
    quantity: "1",
    price: spec.net,
    name: "Gutschrift",
    ...positionSums(spec),
  }));
}

/** `GET /VoucherPos` rows of one voucher (account 4266 unless given). */
export function voucherPositions(voucherId: number, positions: readonly PositionSpec[]): Raw[] {
  return positions.map((spec) => ({
    id: String((positionId += 1)),
    objectName: "VoucherPos",
    voucher: { id: String(voucherId), objectName: "Voucher" },
    accountDatev: { id: String(spec.account ?? 4266), objectName: "AccountDatev" },
    isAsset: spec.asset === true ? "1" : "0",
    net: "1",
    comment: null,
    ...positionSums(spec),
  }));
}

export interface ScenarioDocument {
  readonly row: Raw;
  readonly positions: readonly Raw[];
}

/**
 * Routes for a scenario: the three lists (every row as the whole collection) and one positions
 * route per document (matched by its parent id).
 */
export function scenarioRoutes(input: {
  readonly invoices?: readonly ScenarioDocument[];
  readonly creditNotes?: readonly ScenarioDocument[];
  readonly vouchers?: readonly ScenarioDocument[];
}): FakeRoute[] {
  const list = (path: string, docs: readonly ScenarioDocument[] | undefined): FakeRoute => ({
    path,
    response: { body: { objects: (docs ?? []).map((doc) => doc.row) } },
  });
  const positions = (
    path: string,
    key: string,
    docs: readonly ScenarioDocument[] | undefined,
  ): FakeRoute[] =>
    (docs ?? []).map((doc) => ({
      path,
      query: { [`${key}[id]`]: String(doc.row["id"]) },
      response: { body: { objects: doc.positions } },
    }));
  return [
    list("/Invoice", input.invoices),
    list("/CreditNote", input.creditNotes),
    list("/Voucher", input.vouchers),
    ...positions("/InvoicePos", "invoice", input.invoices),
    ...positions("/CreditNotePos", "creditNote", input.creditNotes),
    ...positions("/VoucherPos", "voucher", input.vouchers),
  ];
}

/** By-id routes for documents a payment points to (`GET /Invoice/{id}` etc.). */
export function byIdRoutes(input: {
  readonly invoices?: readonly ScenarioDocument[];
  readonly creditNotes?: readonly ScenarioDocument[];
  readonly vouchers?: readonly ScenarioDocument[];
}): FakeRoute[] {
  const byId = (name: string, docs: readonly ScenarioDocument[] | undefined): FakeRoute[] =>
    (docs ?? []).map((doc) => ({
      path: `/${name}/${String(doc.row["id"])}`,
      response: { body: { objects: [doc.row] } },
    }));
  return [
    ...byId("Invoice", input.invoices),
    ...byId("CreditNote", input.creditNotes),
    ...byId("Voucher", input.vouchers),
  ];
}

/** `GET /SevClient` for a regular VAT account (the drafts fixture). */
export const regularAccount: FakeRoute = {
  path: "/SevClient",
  response: { fixture: "drafts/sev-client.json" },
};

/** `GET /SevClient` for a Kleinunternehmer account. */
export const smallBusinessAccount: FakeRoute = {
  path: "/SevClient",
  response: { fixture: "drafts/sev-client-small-business.json" },
};
