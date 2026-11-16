/**
 * A quarter (2026-Q1) of documents with known positives and negatives for the audit checks, built
 * from the community and recorded fixtures (recorded key sets and scalar types, fake values):
 * contacts (`GET /Contact`), their addresses (`GET /ContactAddress`), vouchers, invoices, credit
 * notes and their positions. Country ids are those of the recorded StaticCountry table.
 *
 * Every document says in `expect` what the `vat` check must make of it: a finding code, `ok` (no
 * finding: the false-positive cases the issue names), `not_judged` or `out_of_scope`.
 */
import type { FakeRoute } from "../../../../helpers/fake-client.js";
import { loadFixture } from "../../../../helpers/fake-client.js";
import { contactRow } from "../../../tools/reports/records.js";
import {
  invoiceDoc,
  invoicePositions,
  type PositionSpec,
  type ScenarioDocument,
  scenarioRoutes,
  voucherDoc,
  voucherPositions,
} from "../builders.js";

type Raw = Record<string, unknown>;

/** StaticCountry ids of the recorded table (`recorded/2026-11-07/meta/static-countries.json`). */
export const COUNTRY = {
  DE: 1,
  CH: 2,
  AT: 3,
  FR: 11,
  IE: 13,
  LU: 17,
  NL: 18,
  PL: 21,
  US: 1353,
} as const;

/** The import VAT account (Einfuhrumsatzsteuer, AccountDatev id 2624, `import-vat.ts`). */
const IMPORT_VAT_ACCOUNT = 2624;

interface ContactSpec {
  readonly id: number;
  readonly name: string;
  readonly vatNumber?: string;
  readonly countries: readonly number[];
}

/** Suppliers and customers, each with the case it stands for. */
export const CONTACTS = {
  /** An Irish software company: EU VAT id and address. */
  irishSaas: { id: 2001, name: "Cloud Ltd", vatNumber: "IE 1234567T", countries: [COUNTRY.IE] },
  /** A US company in the non-Union OSS scheme (VAT id EU…): outside the EU. */
  usSaas: { id: 2002, name: "SaaS Inc", vatNumber: "EU372000041", countries: [COUNTRY.US] },
  /** An Austrian hotel known only by its address. */
  austrianHotel: { id: 2003, name: "Hotel Wien", countries: [COUNTRY.AT] },
  /** A Luxembourg company registered for VAT in Germany (German VAT id): may charge German VAT. */
  registeredInGermany: {
    id: 2004,
    name: "Versand S.à r.l.",
    vatNumber: "DE999999999",
    countries: [COUNTRY.LU],
  },
  /** A German Kleinunternehmer: German address, no VAT id, charges no VAT. */
  kleinunternehmer: { id: 2005, name: "Grafik Müller", countries: [COUNTRY.DE] },
  /** A Dutch company with a German branch address: may charge German VAT. */
  germanBranch: {
    id: 2006,
    name: "Logistics B.V.",
    vatNumber: "NL123456789B01",
    countries: [COUNTRY.NL, COUNTRY.DE],
  },
  /** A Swiss company: outside the EU. */
  swiss: {
    id: 2007,
    name: "Werkzeug AG",
    vatNumber: "CHE-123.456.789 MWST",
    countries: [COUNTRY.CH],
  },
  /** A contact with neither a VAT id nor an address. */
  unknown: { id: 2008, name: "Ohne Daten", countries: [] },
  /** An Austrian small business in the EU small-business scheme (number ending in EX). */
  euSmallBusiness: {
    id: 2009,
    name: "Atelier Klein",
    vatNumber: "ATU12345678EX",
    countries: [COUNTRY.AT],
  },
  /** A German supplier. */
  german: { id: 2010, name: "Bau GmbH", vatNumber: "DE123456789", countries: [COUNTRY.DE] },
  /** A Polish supplier. */
  polish: {
    id: 2011,
    name: "Budowa Sp. z o.o.",
    vatNumber: "PL1234567890",
    countries: [COUNTRY.PL],
  },
} as const satisfies Record<string, ContactSpec>;

/** A `GET /Contact` row (organisation) built on the community fixture row 1001. */
function contactListRow(spec: ContactSpec): Raw {
  return contactRow({
    id: String(spec.id),
    name: spec.name,
    customerNumber: null,
    vatNumber: spec.vatNumber ?? null,
    taxNumber: null,
    category: { id: "2", objectName: "Category" },
  });
}

const ADDRESS_TEMPLATE = (() => {
  const body = loadFixture("contacts/contact-addresses-1001.json").body as { objects: Raw[] };
  const row = body.objects[0];
  if (row === undefined) throw new Error("contact address fixture is empty");
  return row;
})();

let addressId = 7000;

/** A `GET /ContactAddress` row. */
function addressRow(contactId: number, countryId: number): Raw {
  addressId += 1;
  return {
    ...structuredClone(ADDRESS_TEMPLATE),
    id: String(addressId),
    contact: { id: String(contactId), objectName: "Contact" },
    country: { id: String(countryId), objectName: "StaticCountry" },
  };
}

/** The contact and address lists of `contacts`, and the recorded country table. */
export function directoryRoutes(
  contacts: readonly ContactSpec[] = Object.values(CONTACTS),
): FakeRoute[] {
  return [
    { path: "/Contact", response: { body: { objects: contacts.map(contactListRow) } } },
    {
      path: "/ContactAddress",
      response: {
        body: {
          objects: contacts.flatMap((contact) =>
            contact.countries.map((country) => addressRow(contact.id, country)),
          ),
        },
      },
    },
    {
      path: "/StaticCountry",
      response: { fixture: "recorded/2026-11-07/meta/static-countries.json" },
    },
  ];
}

/** What the `vat` check must make of a document. */
export type Expectation = string;

export interface ExpectedDocument extends ScenarioDocument {
  readonly expect: Expectation;
}

function purchase(
  id: number,
  contact: ContactSpec,
  rule: number,
  positions: readonly PositionSpec[],
  expect: Expectation,
): ExpectedDocument {
  const net = positions.reduce((sum, position) => sum + Number(position.net), 0);
  const tax = positions.reduce((sum, position) => sum + Number(position.tax), 0);
  return {
    row: voucherDoc({
      id,
      date: "2026-02-10",
      rule,
      net: String(net),
      tax: String(tax),
      contactId: contact.id,
    }),
    positions: voucherPositions(id, positions),
    expect,
  };
}

const at19 = (net: string): PositionSpec => ({
  rate: "19",
  net,
  tax: String(Math.round(Number(net) * 19) / 100),
});
const at0 = (net: string, account?: number): PositionSpec => ({
  rate: "0",
  net,
  tax: "0",
  ...(account === undefined ? {} : { account }),
});

/** Purchases: vouchers dated 2026-02-10. */
export const PURCHASES: readonly ExpectedDocument[] = [
  purchase(3101, CONTACTS.usSaas, 9, [at19("100")], "foreign_supplier_charged_german_vat"),
  purchase(3102, CONTACTS.irishSaas, 9, [at0("200")], "foreign_supplier_zero_rate"),
  purchase(
    3103,
    CONTACTS.austrianHotel,
    9,
    [{ rate: "10", net: "300", tax: "30" }],
    "foreign_vat_deducted",
  ),
  // False positives the issue names: foreign suppliers that rightly charge German VAT.
  purchase(3104, CONTACTS.registeredInGermany, 9, [at19("400")], "ok"),
  purchase(3107, CONTACTS.germanBranch, 9, [at19("700")], "ok"),
  // False positives: Kleinunternehmer suppliers (no VAT is right).
  purchase(3105, CONTACTS.kleinunternehmer, 9, [at0("50")], "ok"),
  purchase(3106, CONTACTS.kleinunternehmer, 10, [at0("60")], "ok"),
  purchase(3108, CONTACTS.euSmallBusiness, 9, [at0("80")], "ok"),
  // Reverse charge and acquisitions against the supplier's location.
  purchase(3109, CONTACTS.irishSaas, 14, [at0("900")], "ok"),
  purchase(3110, CONTACTS.german, 14, [at0("1000")], "eu_reverse_charge_for_domestic_supplier"),
  purchase(3111, CONTACTS.german, 12, [at0("1100")], "ok"),
  purchase(3112, CONTACTS.polish, 12, [at0("1200")], "eu_supplier_under_rule_12"),
  purchase(3113, CONTACTS.swiss, 14, [at0("1300")], "eu_reverse_charge_for_non_eu_supplier"),
  purchase(3114, CONTACTS.swiss, 8, [at0("1400")], "acquisition_from_non_eu_supplier"),
  purchase(3115, CONTACTS.german, 8, [at0("1500")], "acquisition_from_domestic_supplier"),
  purchase(3116, CONTACTS.irishSaas, 8, [at0("1600")], "ok"),
  purchase(3117, CONTACTS.unknown, 9, [at19("1700")], "not_judged"),
  // Import VAT booked on the import VAT account with the foreign seller as contact.
  purchase(3118, CONTACTS.usSaas, 9, [at0("190", IMPORT_VAT_ACCOUNT)], "ok"),
  purchase(3119, CONTACTS.austrianHotel, 10, [at0("120")], "foreign_supplier_zero_rate"),
  purchase(3120, CONTACTS.usSaas, 12, [at0("2000")], "ok"),
  purchase(3121, CONTACTS.german, 9, [at19("100")], "ok"),
];

function sale(
  id: number,
  customer: { readonly id: number; readonly vatNumber: string | null; readonly country: number },
  rule: number,
  tax: string,
  expect: Expectation,
  extra: Raw = {},
): ExpectedDocument {
  return {
    row: invoiceDoc(
      {
        id,
        date: "2026-03-05",
        rule,
        net: "1000",
        tax,
        contactId: customer.id,
        vatNumber: customer.vatNumber,
        countryId: customer.country,
      },
      extra,
    ),
    positions: invoicePositions(id, [{ rate: tax === "0" ? "0" : "19", net: "1000", tax }]),
    expect,
  };
}

/** Customers of the sales (embedded in the invoice rows). */
const CUSTOMERS = {
  french: { id: 4001, vatNumber: "FR12345678901", country: COUNTRY.FR },
  frenchWithGermanAddress: { id: 4004, vatNumber: "FR12345678901", country: COUNTRY.DE },
  german: { id: 4002, vatNumber: "DE111111111", country: COUNTRY.DE },
  private: { id: 4003, vatNumber: null, country: COUNTRY.AT },
} as const;

/** Sales: invoices dated 2026-03-05. */
export const SALES: readonly ExpectedDocument[] = [
  sale(3201, CUSTOMERS.french, 1, "190", "german_vat_to_eu_business"),
  sale(3202, CUSTOMERS.frenchWithGermanAddress, 1, "190", "ok"),
  sale(3203, CUSTOMERS.private, 3, "0", "intra_eu_supply_without_eu_vat_id"),
  sale(3204, CUSTOMERS.german, 21, "0", "eu_service_without_eu_vat_id"),
  sale(3205, CUSTOMERS.french, 21, "0", "ok"),
  sale(3206, CUSTOMERS.german, 1, "190", "ok"),
  // A cancellation invoice mirrors its original and is left out.
  sale(3207, CUSTOMERS.french, 1, "-190", "out_of_scope", {
    invoiceType: "SR",
    sumNet: "-1000",
    sumGross: "-1190",
  }),
];

/** The recorded booking accounts (to find the import VAT account by number). */
export const accountDatevRoute: FakeRoute = {
  path: "/AccountDatev",
  response: { fixture: "recorded/2026-11-07/meta/account-datev.json" },
};

/** Routes of the whole quarter: documents, positions, contacts, addresses, countries. */
export function quarterRoutes(): FakeRoute[] {
  return [
    ...scenarioRoutes({ vouchers: PURCHASES, invoices: SALES }),
    ...directoryRoutes(),
    accountDatevRoute,
  ];
}

/** The documents expected to give `code`, by id. */
export function expectedIds(code: Expectation): number[] {
  return [...PURCHASES, ...SALES]
    .filter((document) => document.expect === code)
    .map((document) => Number(document.row["id"]));
}
