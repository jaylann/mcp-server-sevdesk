/**
 * Reference data for sevDesk: the fixed enumerations (contact categories, status codes, document
 * types, Update 2.0 tax rules) and loaders for the account-specific reference lists (countries,
 * units, payment methods).
 *
 * Wrong hard-coded ids were the most common bug class across other sevDesk MCP servers, so every
 * entry names the source it was verified against, and `test/regressions/b9-reference-ids.test.ts`
 * pins the ids. Sources:
 *
 * - **spec**: the vendored OpenAPI file `spec/openapi.yaml` (fetched 2026-11-07), by section.
 * - **recorded**: real responses published by the sevDesk.NET project
 *   (https://github.com/emuuu/sevDesk.NET/blob/main/docs/sevdesk-api-responses.txt, recorded
 *   2026-02-19 on an Update 2.0 account), e.g. `GET /TaxRule` and `GET /Category`.
 */
import { z } from "zod";

import { sanitizeUntrusted } from "../safety/fence.js";
import { parseUpstream, zId, zOptionalString } from "../sevdesk/schema.js";
import type { SevdeskClient } from "../sevdesk/types.js";

// ---------------------------------------------------------------------------------------------
// Contact categories
// ---------------------------------------------------------------------------------------------

/** A standard contact category (Kategorie). Accounts can add their own with other ids. */
export interface ContactCategory {
  readonly id: number;
  /** Stable English key, used as the filter value in tools. */
  readonly key: ContactCategoryKey;
  /** Name in the sevDesk web app (German). */
  readonly name: string;
  readonly nameEn: string;
}

export const CONTACT_CATEGORY_KEYS = ["supplier", "customer", "partner", "prospect"] as const;
export type ContactCategoryKey = (typeof CONTACT_CATEGORY_KEYS)[number];

/**
 * Source: spec tag `Contact` → "Contact Categories" (Supplier 2, Customer 3, Partner 4, Prospect
 * Customer 28); German names from recorded `GET /Category` (objectType `Contact`).
 */
export const CONTACT_CATEGORIES: readonly ContactCategory[] = [
  { id: 2, key: "supplier", name: "Lieferant", nameEn: "Supplier" },
  { id: 3, key: "customer", name: "Kunde", nameEn: "Customer" },
  { id: 4, key: "partner", name: "Partner", nameEn: "Partner" },
  { id: 28, key: "prospect", name: "Interessent", nameEn: "Prospect customer" },
];

/** The standard category with this id, or `undefined` for account-specific categories. */
export function contactCategoryById(id: number): ContactCategory | undefined {
  return CONTACT_CATEGORIES.find((category) => category.id === id);
}

/** The id of a standard contact category. */
export function contactCategoryIdByKey(key: ContactCategoryKey): number {
  const category = CONTACT_CATEGORIES.find((entry) => entry.key === key);
  if (category === undefined) {
    throw new Error(`Unknown contact category key: ${key}`);
  }
  return category.id;
}

/** A category of a contact address (Adresstyp). */
export interface AddressCategory {
  readonly id: number;
  readonly name: string;
  readonly nameEn: string;
}

/**
 * Source: recorded `GET /Category` (objectType `ContactAddress`). Not documented in the spec, which
 * only says "send a GET to /Category?objectType=ContactAddress". (Id 42 "Fax" belongs to objectType
 * `Task`, not to addresses.)
 */
export const ADDRESS_CATEGORIES: readonly AddressCategory[] = [
  { id: 43, name: "Arbeit", nameEn: "Work" },
  { id: 44, name: "Privat", nameEn: "Private" },
  { id: 45, name: "", nameEn: "Empty" },
  { id: 47, name: "Rechnungsanschrift", nameEn: "Invoice address" },
  { id: 48, name: "Lieferanschrift", nameEn: "Delivery address" },
  { id: 49, name: "Abholanschrift", nameEn: "Pickup address" },
];

/** The standard address category with this id, if any. */
export function addressCategoryById(id: number): AddressCategory | undefined {
  return ADDRESS_CATEGORIES.find((category) => category.id === id);
}

// ---------------------------------------------------------------------------------------------
// Communication way keys
// ---------------------------------------------------------------------------------------------

export interface CommunicationWayKey {
  readonly id: number;
  readonly name: string;
  readonly nameEn: string;
}

/**
 * Source: spec tag `CommunicationWay` (Private 1 … Invoicing 8) and `GET /CommunicationWayKey`
 * (German names, `translationCode`), confirmed by the recorded `GET /CommunicationWayKey`.
 */
export const COMMUNICATION_WAY_KEYS: readonly CommunicationWayKey[] = [
  { id: 1, name: "Privat", nameEn: "Private" },
  { id: 2, name: "Arbeit", nameEn: "Work" },
  { id: 3, name: "Fax", nameEn: "Fax" },
  { id: 4, name: "Mobil", nameEn: "Mobile" },
  { id: 5, name: "", nameEn: "Empty" },
  { id: 6, name: "Autobox", nameEn: "Autobox" },
  { id: 7, name: "Newsletter", nameEn: "Newsletter" },
  { id: 8, name: "Rechnungsadresse", nameEn: "Invoicing" },
];

/** The communication way key with this id, if known. */
export function communicationWayKeyById(id: number): CommunicationWayKey | undefined {
  return COMMUNICATION_WAY_KEYS.find((key) => key.id === id);
}

// ---------------------------------------------------------------------------------------------
// Status codes
// ---------------------------------------------------------------------------------------------

export const STATUS_OBJECT_TYPES = [
  "invoice",
  "creditNote",
  "order",
  "voucher",
  "transaction",
  "contact",
] as const;
export type StatusObjectType = (typeof STATUS_OBJECT_TYPES)[number];

export interface StatusCode {
  readonly objectType: StatusObjectType;
  readonly code: number;
  /** Wording of the spec. */
  readonly label: string;
  /** The usual German term in the web app. */
  readonly labelDe: string;
  readonly note?: string;
}

/**
 * Status codes per object type. Sources (all spec):
 * - invoice: tag `Invoice` → "Types and status of invoices". Cancelled invoices have no
 *   documented code.
 * - creditNote: tag `CreditNote` → "Status of credit notes".
 * - order: tag `Order` → "Types and status of orders".
 * - voucher: tag `Voucher` → "Types and status of vouchers".
 * - transaction: `Model_CheckAccountTransactionResponse.status` (includes 350, which tag-level
 *   docs omit).
 * - contact: `Model_ContactResponse.status`.
 */
export const STATUS_CODES: readonly StatusCode[] = [
  {
    objectType: "invoice",
    code: 50,
    label: "Deactivated recurring invoice",
    labelDe: "Deaktivierte Abo-Rechnung",
    note: "Only for recurring invoices (WKR).",
  },
  { objectType: "invoice", code: 100, label: "Draft", labelDe: "Entwurf" },
  { objectType: "invoice", code: 200, label: "Open / due", labelDe: "Offen / fällig" },
  {
    objectType: "invoice",
    code: 750,
    label: "Partially paid",
    labelDe: "Teilweise bezahlt",
    note: "Since release 4.181 (2024-06-13); older partially paid invoices still show 200.",
  },
  { objectType: "invoice", code: 1000, label: "Paid", labelDe: "Bezahlt" },

  { objectType: "creditNote", code: 100, label: "Draft", labelDe: "Entwurf" },
  { objectType: "creditNote", code: 200, label: "Open / delivered", labelDe: "Offen" },
  { objectType: "creditNote", code: 750, label: "Partially paid", labelDe: "Teilweise bezahlt" },
  { objectType: "creditNote", code: 1000, label: "Paid", labelDe: "Bezahlt" },

  { objectType: "order", code: 100, label: "Draft", labelDe: "Entwurf" },
  { objectType: "order", code: 200, label: "Delivered (sent)", labelDe: "Versendet" },
  { objectType: "order", code: 300, label: "Rejected / cancelled", labelDe: "Abgelehnt" },
  { objectType: "order", code: 500, label: "Accepted", labelDe: "Angenommen" },
  {
    objectType: "order",
    code: 750,
    label: "Partially calculated (partially invoiced)",
    labelDe: "Teilweise berechnet",
  },
  { objectType: "order", code: 1000, label: "Calculated (invoiced)", labelDe: "Berechnet" },

  { objectType: "voucher", code: 50, label: "Draft", labelDe: "Entwurf" },
  { objectType: "voucher", code: 100, label: "Unpaid / due", labelDe: "Offen / fällig" },
  {
    objectType: "voucher",
    code: 150,
    label: "Transferred",
    labelDe: "Überwiesen",
    note: "A payment was created in sevDesk; waiting for the bank transaction import.",
  },
  { objectType: "voucher", code: 750, label: "Partially paid", labelDe: "Teilweise bezahlt" },
  { objectType: "voucher", code: 1000, label: "Paid", labelDe: "Bezahlt" },

  { objectType: "transaction", code: 100, label: "Created", labelDe: "Erstellt" },
  { objectType: "transaction", code: 200, label: "Linked", labelDe: "Verknüpft" },
  { objectType: "transaction", code: 300, label: "Private", labelDe: "Privat" },
  {
    objectType: "transaction",
    code: 350,
    label: "Auto-booked without user confirmation",
    labelDe: "Automatisch gebucht",
  },
  { objectType: "transaction", code: 400, label: "Booked", labelDe: "Gebucht" },

  { objectType: "contact", code: 100, label: "Lead", labelDe: "Lead" },
  { objectType: "contact", code: 500, label: "Pending", labelDe: "Ausstehend" },
  { objectType: "contact", code: 1000, label: "Active", labelDe: "Aktiv" },
];

/** The status code entry for an object type and code, if documented. */
export function statusByCode(objectType: StatusObjectType, code: number): StatusCode | undefined {
  return STATUS_CODES.find((status) => status.objectType === objectType && status.code === code);
}

// ---------------------------------------------------------------------------------------------
// Document types
// ---------------------------------------------------------------------------------------------

export interface DocumentType {
  readonly objectType: "invoice" | "order" | "voucher";
  /** The abbreviation sevDesk uses in `invoiceType` / `orderType` / `voucherType`. */
  readonly code: string;
  readonly label: string;
  readonly labelDe: string;
}

/**
 * Sources (spec): tag `Invoice` → "Types and status of invoices"; tag `Order` → "Types and status
 * of orders"; tag `Voucher` → "Types and status of vouchers".
 */
export const DOCUMENT_TYPES: readonly DocumentType[] = [
  { objectType: "invoice", code: "RE", label: "Normal invoice", labelDe: "Rechnung" },
  { objectType: "invoice", code: "WKR", label: "Recurring invoice", labelDe: "Abo-Rechnung" },
  { objectType: "invoice", code: "SR", label: "Cancellation invoice", labelDe: "Stornorechnung" },
  { objectType: "invoice", code: "MA", label: "Reminder invoice", labelDe: "Mahnung" },
  { objectType: "invoice", code: "TR", label: "Partial invoice", labelDe: "Teilrechnung" },
  { objectType: "invoice", code: "AR", label: "Advance invoice", labelDe: "Abschlagsrechnung" },
  { objectType: "invoice", code: "ER", label: "Final invoice", labelDe: "Schlussrechnung" },
  { objectType: "order", code: "AN", label: "Estimate / proposal", labelDe: "Angebot" },
  { objectType: "order", code: "AB", label: "Order confirmation", labelDe: "Auftragsbestätigung" },
  { objectType: "order", code: "LI", label: "Delivery note", labelDe: "Lieferschein" },
  { objectType: "voucher", code: "VOU", label: "Normal voucher", labelDe: "Beleg" },
  {
    objectType: "voucher",
    code: "RV",
    label: "Recurring voucher",
    labelDe: "Wiederkehrender Beleg",
  },
];

/** The document type entry for an object type and abbreviation, if documented. */
export function documentTypeByCode(
  objectType: DocumentType["objectType"],
  code: string,
): DocumentType | undefined {
  return DOCUMENT_TYPES.find((type) => type.objectType === objectType && type.code === code);
}

// ---------------------------------------------------------------------------------------------
// Tax rules (sevDesk Update 2.0)
// ---------------------------------------------------------------------------------------------

/** Who may use a tax rule: regular VAT payers (Regelbesteuerer) and/or small businesses (§19). */
type TaxRegime = "regular" | "small_business";

export interface TaxRule {
  readonly id: number;
  /** Upstream `code` from `GET /TaxRule` (recorded). */
  readonly code: string;
  /** Upstream name (German). */
  readonly nameDe: string;
  readonly nameEn: string;
  /** Revenue (Einnahme: invoices, revenue vouchers) or expense (Ausgabe: expense vouchers). */
  readonly direction: "revenue" | "expense" | "either";
  readonly regimes: readonly TaxRegime[];
  /**
   * Tax rates allowed in positions; `undefined` when they depend on the destination country (OSS)
   * or are not documented.
   */
  readonly allowedTaxRates?: readonly number[];
  /** The Update 1.0 `taxType` this rule replaces. */
  readonly legacyTaxType?: string;
  /** Use cases sevDesk rejects with this rule. */
  readonly notSupportedFor?: readonly string[];
  /** False when the rule exists (`GET /TaxRule`) but the spec's tax rule tables don't list it. */
  readonly documented: boolean;
  readonly note?: string;
}

const NO_ADVANCE_PARTIAL_FINAL = [
  "advance invoices (AR)",
  "partial invoices (TR)",
  "final invoices (ER)",
] as const;

const OSS_NOT_SUPPORTED = [
  "vouchers",
  "e-invoices",
  "invoices with a custom revenue account (accountDatev)",
  ...NO_ADVANCE_PARTIAL_FINAL,
];

/**
 * The Update 2.0 tax rules. Source for ids, rates, legacy `taxType` and unsupported use cases:
 * spec info section "sevdesk-Update 2.0" → "Tax Rules" (four tables: Regelbesteuerung revenue /
 * expense, Kleinunternehmer revenue / expense). Source for `code` and upstream names: recorded
 * `GET /TaxRule`. Rules 15, 16 and 22 appear only in `GET /TaxRule`, not in the spec tables.
 *
 * Known spec inconsistencies (the tables win):
 * - The `Voucher` tag lists "1 - Steuer nicht erhoben nach §19UStG" for Kleinunternehmer; the
 *   tables and `GET /TaxRule` say 11.
 * - The tables call 21 "Reverse Charge gem. §18b UStG (field 21 in VAT return)"; `GET /TaxRule`
 *   names it "Reverse Charge gem. §13b Abs. 1 USTG EU Umsätze". Both describe services to
 *   businesses in other EU states, reported in UStVA field 21.
 */
export const TAX_RULES: readonly TaxRule[] = [
  {
    id: 1,
    code: "USTPFL_UMS_EINN",
    nameDe: "Umsatzsteuerpflichtige Umsätze",
    nameEn: "Taxable domestic revenue",
    direction: "revenue",
    regimes: ["regular"],
    allowedTaxRates: [0, 7, 19],
    legacyTaxType: "default",
    documented: true,
  },
  {
    id: 2,
    code: "AUSFUHREN",
    nameDe: "Ausfuhren",
    nameEn: "Exports to non-EU countries",
    direction: "revenue",
    regimes: ["regular"],
    allowedTaxRates: [0],
    documented: true,
  },
  {
    id: 3,
    code: "INNERGEM_LIEF",
    nameDe: "Innergemeinschaftliche Lieferungen",
    nameEn: "Intra-EU supplies",
    direction: "revenue",
    regimes: ["regular"],
    allowedTaxRates: [0, 7, 19],
    legacyTaxType: "eu",
    documented: true,
  },
  {
    id: 4,
    code: "STFREIE_UMS_P4",
    nameDe: "Steuerfreie Umsätze §4 UStG",
    nameEn: "Tax-exempt revenue (§4 UStG)",
    direction: "revenue",
    regimes: ["regular"],
    allowedTaxRates: [0],
    documented: true,
  },
  {
    id: 5,
    code: "REV_CHARGE_13B_1",
    nameDe: "Reverse Charge gem. §13b UStG",
    nameEn: "Reverse charge, recipient owes the VAT (§13b UStG)",
    direction: "revenue",
    regimes: ["regular"],
    allowedTaxRates: [0],
    documented: true,
    note: "UStVA field 60 (domestic reverse charge, e.g. construction services).",
  },
  {
    id: 8,
    code: "INNERGEM_ERWERB",
    nameDe: "Innergemeinschaftliche Erwerbe",
    nameEn: "Intra-EU acquisitions",
    direction: "expense",
    regimes: ["regular"],
    allowedTaxRates: [0, 7, 19],
    documented: true,
  },
  {
    id: 9,
    code: "VORST_ABZUGSF_AUFW",
    nameDe: "Vorsteuerabziehbare Aufwendungen",
    nameEn: "Expenses with input VAT deduction",
    direction: "expense",
    regimes: ["regular"],
    allowedTaxRates: [0, 7, 19],
    legacyTaxType: "default",
    documented: true,
  },
  {
    id: 10,
    code: "NICHT_VORST_ABZUGSF_AUFW",
    nameDe: "Nicht vorsteuerabziehbare Aufwendungen",
    nameEn: "Expenses without input VAT deduction",
    direction: "expense",
    regimes: ["regular", "small_business"],
    allowedTaxRates: [0],
    legacyTaxType: "ss",
    documented: true,
    note: "legacyTaxType 'ss' applies to small businesses only.",
  },
  {
    id: 11,
    code: "KLEINUNTERNEHMER_P19",
    nameDe: "Steuer nicht erhoben nach §19UStG",
    nameEn: "Small business, no VAT charged (§19 UStG, Kleinunternehmer)",
    direction: "revenue",
    regimes: ["small_business"],
    allowedTaxRates: [0],
    legacyTaxType: "ss",
    documented: true,
  },
  {
    id: 12,
    code: "REV_CHARGE_13B_MIT_VORST_ABZUG_0",
    nameDe: "Reverse Charge gem. §13b Abs. 2 UStG mit Vorsteuerabzug 0% (19%)",
    nameEn: "Reverse charge §13b(2) UStG with input VAT deduction",
    direction: "expense",
    regimes: ["regular"],
    allowedTaxRates: [0],
    documented: true,
    note: "E.g. services from non-EU countries, construction services.",
  },
  {
    id: 13,
    code: "REV_CHARGE_13B_OHNE_VORST_ABZUG_0",
    nameDe: "Reverse Charge gem. §13b UStG ohne Vorsteuerabzug 0% (19%)",
    nameEn: "Reverse charge §13b UStG without input VAT deduction",
    direction: "expense",
    regimes: ["regular", "small_business"],
    allowedTaxRates: [0],
    documented: true,
    note: "E.g. small businesses, insurance agents, doctors.",
  },
  {
    id: 14,
    code: "REV_CHARGE_13B_EU_0",
    nameDe: "Reverse Charge gem. §13b Abs. 1 EU Umsätze 0% (19%)",
    nameEn: "Reverse charge §13b(1) UStG, services from EU states",
    direction: "expense",
    regimes: ["regular"],
    allowedTaxRates: [0],
    documented: true,
  },
  {
    id: 15,
    code: "NICHT_STEUERBAR_TAX",
    nameDe: "Nicht Steuerbar (Steuer)",
    nameEn: "Not taxable (tax payments)",
    direction: "either",
    regimes: ["regular", "small_business"],
    documented: false,
    note: "E.g. VAT prepayments or VAT refunds. Only in GET /TaxRule.",
  },
  {
    id: 16,
    code: "NICHT_STEUERBAR_EXPENSE",
    nameDe: "Nicht Steuerbar (Ausgabe)",
    nameEn: "Not taxable (expense)",
    direction: "expense",
    regimes: ["regular", "small_business"],
    documented: false,
    note: "E.g. private withdrawals or own consumption. Only in GET /TaxRule.",
  },
  {
    id: 17,
    code: "NICHT_IM_INLAND_STEUERBAR",
    nameDe: "Nicht im Inland steuerbare Leistung",
    nameEn: "Not taxable in Germany (e.g. services to Switzerland)",
    direction: "revenue",
    regimes: ["regular"],
    allowedTaxRates: [0],
    legacyTaxType: "noteu",
    notSupportedFor: [...NO_ADVANCE_PARTIAL_FINAL],
    documented: true,
  },
  {
    id: 18,
    code: "OSS_GOODS",
    nameDe: "One-Stop-Shop - Warenverkauf in die EU",
    nameEn: "One-Stop-Shop: goods to EU consumers",
    direction: "revenue",
    regimes: ["regular"],
    notSupportedFor: OSS_NOT_SUPPORTED,
    documented: true,
    note: "Tax rate depends on the destination country.",
  },
  {
    id: 19,
    code: "OSS_SERVICES",
    nameDe: "One-Stop-Shop - elektronische Dienstleistungen in die EU",
    nameEn: "One-Stop-Shop: electronic services to EU consumers",
    direction: "revenue",
    regimes: ["regular"],
    notSupportedFor: OSS_NOT_SUPPORTED,
    documented: true,
    note: "Tax rate depends on the destination country.",
  },
  {
    id: 20,
    code: "OSS_OTHER",
    nameDe: "One-Stop-Shop - Sonstige Leistungen in die EU",
    nameEn: "One-Stop-Shop: other services to EU consumers",
    direction: "revenue",
    regimes: ["regular"],
    notSupportedFor: OSS_NOT_SUPPORTED,
    documented: true,
    note: "Tax rate depends on the destination country.",
  },
  {
    id: 21,
    code: "REV_CHARGE_13B_1_USTG",
    nameDe: "Reverse Charge gem. §13b Abs. 1 USTG EU Umsätze",
    nameEn: "Reverse charge: services to businesses in other EU states (§18b UStG)",
    direction: "revenue",
    regimes: ["regular"],
    allowedTaxRates: [0],
    notSupportedFor: ["vouchers", ...NO_ADVANCE_PARTIAL_FINAL],
    documented: true,
    note: "UStVA field 21. The spec names it 'Reverse Charge gem. §18b UStG'.",
  },
  {
    id: 22,
    code: "NICHT_STEUERBAR_REVENUE",
    nameDe: "Nicht Steuerbar (Einnahme)",
    nameEn: "Not taxable (revenue)",
    direction: "revenue",
    regimes: ["regular", "small_business"],
    documented: false,
    note: "E.g. transitory items (durchlaufende Posten). Only in GET /TaxRule.",
  },
];

/** The tax rule with this id, if known. */
export function taxRuleById(id: number): TaxRule | undefined {
  return TAX_RULES.find((rule) => rule.id === id);
}

// ---------------------------------------------------------------------------------------------
// Account-specific reference lists (fetched from sevDesk)
// ---------------------------------------------------------------------------------------------

/** Page size for reference lists: sevDesk's maximum, so the lists are never cut at 100. */
const REFERENCE_LIST_LIMIT = 1000;
const REFERENCE_NAME_MAX = 200;

/** A reference list fetched from sevDesk, with the count sevDesk reported. */
export interface ReferenceList<T> {
  readonly items: readonly T[];
  /** sevDesk's `total` when it sent one, else the number of items received. */
  readonly total: number;
}

export interface Country {
  readonly id: number;
  /** ISO 3166-1 alpha-2, lower case as sevDesk sends it (e.g. "de"). */
  readonly code?: string | undefined;
  readonly name: string;
  readonly nameEn?: string | undefined;
}

export interface Unit {
  readonly id: number;
  readonly name: string;
  /** UN/ECE Recommendation 20 unit code used in e-invoices (e.g. "C62", "HUR"). */
  readonly uneceCode?: string | undefined;
}

export interface PaymentMethod {
  readonly id: number;
  readonly name: string;
  readonly text?: string | undefined;
}

/** `GET /StaticCountry` (undocumented). Shape from the recorded response. */
const countrySchema = z.object({
  id: zId,
  code: zOptionalString,
  name: zOptionalString,
  nameEn: zOptionalString,
});

/** `GET /Unity` (undocumented). Shape from the recorded response. */
const unitSchema = z.object({
  id: zId,
  name: zOptionalString,
  uneceTradeUnitCode: zOptionalString,
});

/**
 * `GET /PaymentMethod` (undocumented). Shape from j-mastr's patched spec
 * (`ModelPaymentMethodResponse`); no recorded response was available.
 */
const paymentMethodSchema = z.object({
  id: zId,
  name: zOptionalString,
  text: zOptionalString,
});

/** Lists the countries sevDesk knows (`GET /StaticCountry`), e.g. for `country` references. */
export async function listCountries(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<ReferenceList<Country>> {
  return fetchReferenceList(
    client,
    "/StaticCountry",
    "countries",
    countrySchema,
    (row) => ({
      id: row.id,
      code: cleanOptional(row.code),
      name: cleanName(row.name ?? row.nameEn, row.id),
      nameEn: cleanOptional(row.nameEn),
    }),
    signal,
  );
}

/** Lists the units of measure of the account (`GET /Unity`), used by positions and parts. */
export async function listUnits(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<ReferenceList<Unit>> {
  return fetchReferenceList(
    client,
    "/Unity",
    "units",
    unitSchema,
    (row) => ({
      id: row.id,
      name: cleanName(row.name, row.id),
      uneceCode: cleanOptional(row.uneceTradeUnitCode),
    }),
    signal,
  );
}

/** Lists the payment methods of the account (`GET /PaymentMethod`), used by invoices. */
export async function listPaymentMethods(
  client: SevdeskClient,
  signal?: AbortSignal,
): Promise<ReferenceList<PaymentMethod>> {
  return fetchReferenceList(
    client,
    "/PaymentMethod",
    "payment methods",
    paymentMethodSchema,
    (row) => ({
      id: row.id,
      name: cleanName(row.name ?? row.text, row.id),
      text: cleanOptional(row.text),
    }),
    signal,
  );
}

async function fetchReferenceList<S extends z.ZodType, T>(
  client: SevdeskClient,
  path: string,
  what: string,
  schema: S,
  map: (row: z.output<S>) => T,
  signal: AbortSignal | undefined,
): Promise<ReferenceList<T>> {
  const page = await client.list(path, undefined, {
    limit: REFERENCE_LIST_LIMIT,
    ...(signal === undefined ? {} : { signal }),
  });
  const items = page.items.map((raw) => map(parseUpstream(schema, raw, what)));
  return { items, total: page.total ?? items.length };
}

function cleanOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : sanitizeUntrusted(value, REFERENCE_NAME_MAX);
}

/** Upstream names are untrusted (units and payment methods can be user-defined). */
function cleanName(value: string | undefined, id: number): string {
  const cleaned = cleanOptional(value);
  return cleaned === undefined || cleaned.trim() === "" ? `(unnamed ${id})` : cleaned;
}
