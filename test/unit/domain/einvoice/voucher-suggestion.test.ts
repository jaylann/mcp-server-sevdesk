import { describe, expect, it } from "vitest";

import type { AccountCompany } from "../../../../src/domain/account-settings.js";
import type { ContactDto } from "../../../../src/domain/contacts.js";
import type { ParsedEInvoice, VatCategoryCode } from "../../../../src/domain/einvoice/model.js";
import { parseEInvoice } from "../../../../src/domain/einvoice/parse.js";
import {
  type ContactIndex,
  directionOf,
  findOwnInvoice,
  loadContactIndex,
  MAX_SCANNED_CONTACTS,
  normalizeName,
  planVoucherFromEInvoice,
  suggestVoucherFields,
} from "../../../../src/domain/einvoice/voucher-suggestion.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { einvoiceFixture } from "./helpers.js";

type Row = Record<string, unknown>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

/** The account is the buyer of the synthetic invoice (Musterfirma GmbH, DE000000000). */
const BUYER_COMPANY: AccountCompany = { name: "Musterfirma GmbH", vatNumber: "DE000000000" };
/** The account is the seller (Musterlieferant GmbH). */
const SELLER_COMPANY: AccountCompany = { vatNumber: "DE000000001" };
const NO_CONTACTS: ContactIndex = { rows: [], scanned: 0, complete: true };

// Top-level await: the `it.each` tables below build their variants at collection time.
const base: ParsedEInvoice = await parseEInvoice(
  einvoiceFixture("generated/cii-en16931-invoice.xml"),
);

function variant(change: (invoice: Mutable<ParsedEInvoice>) => void): ParsedEInvoice {
  const invoice = structuredClone(base) as Mutable<ParsedEInvoice>;
  change(invoice);
  return invoice;
}

/** One VAT breakdown row of `category`, seller/buyer in the given countries. */
function single(
  category: VatCategoryCode,
  options: { rate?: string; tax?: string; seller?: string; buyer?: string } = {},
): ParsedEInvoice {
  return variant((invoice) => {
    invoice.vatBreakdown = [
      {
        category,
        rate: options.rate ?? "0",
        taxableAmount: "100.00",
        taxAmount: options.tax ?? "0.00",
      },
    ];
    if (options.seller !== undefined) invoice.seller.address.countryCode = options.seller;
    if (options.buyer !== undefined) invoice.buyer.address.countryCode = options.buyer;
  });
}

function contact(id: number, displayName: string, extra: Partial<ContactDto> = {}): ContactDto {
  return { id, kind: "organisation", displayName, ...extra };
}

function suggest(
  parsed: ParsedEInvoice,
  inputs: Partial<Parameters<typeof suggestVoucherFields>[1]> = {},
) {
  return suggestVoucherFields(parsed, {
    regime: "regular",
    company: BUYER_COMPANY,
    contacts: NO_CONTACTS,
    ownInvoice: { status: "none" },
    ...inputs,
  });
}

describe("directionOf", () => {
  it.each([
    [{ vatNumber: "de 000 000 000" }, "expense", "buyer_vat_id"],
    [{ vatNumber: "DE000000001" }, "revenue", "seller_vat_id"],
    [{ taxNumber: "00 000 00001" }, "revenue", "seller_tax_number"],
    [{ name: "MUSTERFIRMA GmbH." }, "expense", "buyer_name"],
    [{ name: "Musterlieferant  GmbH" }, "revenue", "seller_name"],
    [{ name: "Someone else" }, "expense", "assumed_expense"],
    [{}, "expense", "assumed_expense"],
    [undefined, "expense", "assumed_expense"],
  ] as const)("company %o → %s (%s)", (company, kind, basis) => {
    expect(directionOf(base, company)).toMatchObject({ kind, basis, ambiguous: false });
  });

  it("treats a company that is both parties as the buyer and flags it", () => {
    const self = variant((invoice) => void (invoice.seller.vatId = "DE000000000"));
    expect(directionOf(self, BUYER_COMPANY)).toEqual({
      kind: "expense",
      basis: "buyer_vat_id",
      ambiguous: true,
    });
    expect(suggest(self).warnings.join(" ")).toContain("Both the seller and the buyer");
  });
});

describe("suggestVoucherFields", () => {
  it("suggests an expense with rule 9 and one position per rate", () => {
    const suggestion = suggest(base, {
      contacts: {
        rows: [
          {
            contact: contact(1003, "Beispiel Lieferant AG", { vatNumber: "DE000000001" }),
            vatId: "DE000000001",
          },
          { contact: contact(1004, "Other GmbH") },
        ],
        scanned: 2,
        complete: true,
      },
    });
    expect(suggestion).toEqual({
      kind: "expense",
      kindBasis: "buyer_vat_id",
      counterparty: {
        role: "seller",
        name: "Musterlieferant GmbH",
        vatId: "DE000000001",
        ibanMasked: "****3000",
      },
      supplierCandidates: [
        {
          contactId: 1003,
          displayName: "Beispiel Lieferant AG",
          vatNumber: "DE000000001",
          matchedBy: "vat_id",
        },
      ],
      supplierId: 1003,
      supplierSearch: { scanned: 2, complete: true },
      taxRuleId: 9,
      taxRuleName: "Vorsteuerabziehbare Aufwendungen",
      taxRuleReason: "Domestic invoice with VAT: input VAT is deductible (rule 9, §15 UStG).",
      foldVatForZeroRule: false,
      positions: [
        {
          vatCategory: "S",
          taxRate: "19",
          net: { amount: "190.00", currency: "EUR" },
          tax: { amount: "36.10", currency: "EUR" },
          gross: { amount: "226.10", currency: "EUR" },
        },
        {
          vatCategory: "S",
          taxRate: "7",
          net: { amount: "30.00", currency: "EUR" },
          tax: { amount: "2.10", currency: "EUR" },
          gross: { amount: "32.10", currency: "EUR" },
        },
      ],
      voucherDate: "2026-01-15",
      number: "RE-2026-0001",
      deliveryDate: "2026-01-12",
      paymentDeadline: "2026-01-29",
      currency: "EUR",
      totals: {
        net: { amount: "220.00", currency: "EUR" },
        tax: { amount: "38.20", currency: "EUR" },
        gross: { amount: "258.20", currency: "EUR" },
        due: { amount: "258.20", currency: "EUR" },
      },
      blocking: [],
      warnings: [],
    });
  });

  it.each([
    ["S from DE", single("S", { rate: "19", tax: "19.00", seller: "DE" }), "regular", "expense", 9],
    [
      "S from AT, Kleinunternehmer",
      single("S", { rate: "20", tax: "20.00", seller: "AT" }),
      "small_business",
      "expense",
      10,
    ],
    ["Z", single("Z"), "regular", "expense", 9],
    ["E", single("E"), "regular", "expense", 9],
    ["O", single("O"), "regular", "expense", 9],
    ["G", single("G"), "regular", "expense", 9],
    ["AE from DE", single("AE", { seller: "DE" }), "regular", "expense", 12],
    ["AE from AT", single("AE", { seller: "AT" }), "regular", "expense", 14],
    ["AE from CH", single("AE", { seller: "CH" }), "regular", "expense", 12],
    ["K", single("K", { seller: "AT" }), "regular", "expense", 8],
    ["AE, Kleinunternehmer", single("AE"), "small_business", "expense", 13],
    [
      "S, Kleinunternehmer",
      single("S", { rate: "19", tax: "19.00" }),
      "small_business",
      "expense",
      10,
    ],
    ["K, Kleinunternehmer", single("K"), "small_business", "expense", 10],
    ["S revenue", single("S", { rate: "19", tax: "19.00" }), "regular", "revenue", 1],
    ["Z revenue", single("Z"), "regular", "revenue", 1],
    ["E revenue", single("E"), "regular", "revenue", 4],
    ["AE revenue to DE", single("AE", { buyer: "DE" }), "regular", "revenue", 5],
    ["AE revenue to US", single("AE", { buyer: "US" }), "regular", "revenue", 17],
    ["K revenue", single("K", { buyer: "AT" }), "regular", "revenue", 3],
    ["G revenue", single("G", { buyer: "US" }), "regular", "revenue", 2],
    ["revenue, Kleinunternehmer", single("E"), "small_business", "revenue", 11],
  ] as const)("%s → tax rule %i", (_label, parsed, regime, kind, rule) => {
    const suggestion = suggest(parsed, {
      regime,
      company: kind === "expense" ? BUYER_COMPANY : SELLER_COMPANY,
    });
    expect(suggestion.kind).toBe(kind);
    expect(suggestion.taxRuleId).toBe(rule);
    expect(suggestion.blocking).toEqual([]);
  });

  it.each([
    ["AE revenue to an EU buyer", single("AE", { buyer: "FR" }), "rule 21"],
    ["O revenue", single("O"), "case-by-case"],
    ["L revenue", single("L", { rate: "7", tax: "7.00" }), "case-by-case"],
  ])("blocks %s (no voucher rule)", (_label, parsed, expected) => {
    const suggestion = suggest(parsed, { company: SELLER_COMPANY });
    expect(suggestion.taxRuleId).toBeUndefined();
    expect(suggestion.taxRuleReason).toContain(expected);
    expect(suggestion.blocking).toContain(suggestion.taxRuleReason);
  });

  it.each([
    ["S from AT", single("S", { rate: "20", tax: "20.00", seller: "AT" })],
    ["L", single("L", { rate: "7", tax: "7.00" })],
  ])("blocks foreign VAT on a regular account (%s): rule 10 is not offered", (_label, parsed) => {
    const suggestion = suggest(parsed);
    expect(suggestion.taxRuleId).toBeUndefined();
    expect(suggestion.foldVatForZeroRule).toBe(false);
    expect(suggestion.blocking).toEqual([
      expect.stringContaining("foreign VAT, which is not deductible"),
    ]);
  });

  it("flags non-deductible VAT for folding and keeps the invoice's VAT rows", () => {
    const suggestion = suggest(base, { regime: "small_business" });
    expect(suggestion.taxRuleId).toBe(10);
    expect(suggestion.foldVatForZeroRule).toBe(true);
    expect(suggestion.foldVatReason).toBe(
      "Tax rule 10 allows only 0 %, so the VAT on the invoice is not deductible and is booked " +
        "as part of the expense: each position at 0 % with amount = gross.",
    );
    expect(suggestion.warnings).toContain(suggestion.foldVatReason);
    expect(suggestion.blocking).toEqual([]);
    expect(
      suggestion.positions.map((position) => [
        position.taxRate,
        position.net.amount,
        position.tax.amount,
        position.gross.amount,
      ]),
    ).toEqual([
      ["19", "190.00", "36.10", "226.10"],
      ["7", "30.00", "2.10", "32.10"],
    ]);
    // No VAT on the invoice: nothing to fold under a 0 %-only rule.
    const exempt = suggest(single("E"), { regime: "small_business" });
    expect(exempt).toMatchObject({ taxRuleId: 10, foldVatForZeroRule: false });
    expect(exempt.foldVatReason).toBeUndefined();
  });

  it("warns about VAT on a Kleinunternehmer revenue invoice and about K acquisitions", () => {
    expect(
      suggest(base, { regime: "small_business", company: SELLER_COMPANY }).warnings.join(" "),
    ).toContain("§14c");
    expect(suggest(single("K"), { regime: "small_business" }).warnings.join(" ")).toContain("§1a");
    expect(suggest(single("K", { seller: "AT" })).warnings.join(" ")).toContain("German rate");
    expect(suggest(single("G")).warnings.join(" ")).toContain("export (G)");
  });

  it("blocks a rate the rule does not allow, mixed rules and missing breakdowns", () => {
    expect(
      suggest(single("S", { rate: "16", tax: "16.00", seller: "DE" })).blocking.join(" "),
    ).toContain("VAT rate 16 % is not allowed with tax rule 9");
    const mixed = variant((invoice) => {
      invoice.vatBreakdown.push({ category: "AE", rate: "0", taxableAmount: "0", taxAmount: "0" });
    });
    expect(suggest(mixed).blocking.join(" ")).toContain("mixes VAT categories (S, AE)");
    const empty = variant((invoice) => void (invoice.vatBreakdown = []));
    expect(suggest(empty).blocking).toEqual([
      "The invoice has no VAT breakdown, so no tax rule can be suggested.",
      "The invoice has no VAT breakdown (BG-23), so no voucher positions can be built.",
    ]);
  });

  it("blocks credit notes, other documents, foreign currencies and amount errors", () => {
    const blockingOf = (change: (invoice: Mutable<ParsedEInvoice>) => void): string =>
      suggest(variant(change)).blocking.join(" ");
    expect(
      blockingOf((invoice) => {
        invoice.documentKind = "credit_note";
        invoice.typeCode = "381";
      }),
    ).toContain("credit note (Gutschrift, type code 381)");
    expect(
      blockingOf((invoice) => {
        invoice.documentKind = "credit_note";
        invoice.typeCode = "X1";
      }),
    ).toContain("type code unknown");
    expect(blockingOf((invoice) => void (invoice.documentKind = "other"))).toContain(
      "does not mark an invoice",
    );
    expect(blockingOf((invoice) => void (invoice.currency = "USD"))).toContain("in USD");
    expect(
      blockingOf((invoice) => {
        invoice.findings = [{ code: "BR-CO-10", severity: "error", message: "m" }];
      }),
    ).toContain("1 error(s) in its amounts, VAT breakdown or profile (BR-CO-10)");
  });

  it("only warns about formal defects, prepaid amounts and an unknown regime", () => {
    const suggestion = suggestVoucherFields(
      variant((invoice) => {
        invoice.findings = [
          { code: "BR-DE-15", severity: "error", message: "m" },
          { code: "SD-HIDDEN-TEXT", severity: "warning", message: "m" },
        ];
        invoice.totals.prepaid = "58.20";
      }),
      { regime: undefined, company: BUYER_COMPANY, contacts: NO_CONTACTS },
    );
    expect(suggestion.blocking).toEqual([]);
    expect(suggestion.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("1 formal defect(s) (BR-DE-15)"),
        expect.stringContaining("58.20 EUR as already paid"),
        expect.stringContaining("could not be read; the tax rule assumes regular VAT"),
        expect.stringContaining("No sevDesk contact matches the supplier"),
      ]),
    );
  });

  it("takes the service period when there is no delivery date", () => {
    const suggestion = suggest(
      variant((invoice) => {
        delete invoice.deliveryDate;
        invoice.periodStart = "2026-01-01";
        invoice.periodEnd = "2026-01-31";
      }),
    );
    expect(suggestion).toMatchObject({
      deliveryDate: "2026-01-01",
      deliveryDateUntil: "2026-01-31",
    });
  });

  it("matches contacts by VAT id, IBAN and exact name, strongest first", () => {
    const rows = [
      { contact: contact(5, "Musterlieferant GmbH") },
      { contact: contact(4, "Musterlieferant"), iban: "DE89370400440532013000" },
      { contact: contact(3, "X", { vatNumber: "DE000000001" }), vatId: "DE000000001" },
      { contact: contact(2, "Y", { vatNumber: "DE000000001" }), vatId: "DE000000001" },
    ];
    const both = suggest(base, { contacts: { rows, scanned: 4, complete: true } });
    expect(both.supplierCandidates.map((c) => [c.contactId, c.matchedBy])).toEqual([
      [2, "vat_id"],
      [3, "vat_id"],
      [4, "iban"],
      [5, "name"],
    ]);
    expect(both.supplierId).toBeUndefined();
    expect(both.warnings.join(" ")).toContain("Several contacts share the VAT id or IBAN");

    const byIban = suggest(base, {
      contacts: { rows: rows.slice(0, 2), scanned: 2, complete: false },
    });
    expect(byIban.supplierId).toBe(4);
    expect(byIban.warnings.join(" ")).toContain("Only the first 2 contacts were compared");

    const byName = suggest(base, {
      contacts: { rows: rows.slice(0, 1), scanned: 1, complete: true },
    });
    expect(byName.supplierId).toBeUndefined();
    expect(byName.warnings).toContain(
      "The contact matched by name only; confirm it before booking.",
    );
  });

  it("matches the buyer for revenue (no IBAN) and names the customer", () => {
    const suggestion = suggest(base, {
      company: SELLER_COMPANY,
      contacts: {
        rows: [{ contact: contact(9, "Musterfirma GmbH"), iban: "DE89370400440532013000" }],
        scanned: 1,
        complete: true,
      },
    });
    expect(suggestion.counterparty).toEqual({
      role: "buyer",
      name: "Musterfirma GmbH",
      vatId: "DE000000000",
    });
    expect(suggestion.supplierCandidates).toEqual([
      { contactId: 9, displayName: "Musterfirma GmbH", matchedBy: "name" },
    ]);
    expect(suggest(base, { company: SELLER_COMPANY }).warnings.join(" ")).toContain(
      "matches the customer",
    );
  });

  it("blocks revenue that sevDesk already has as an invoice, or that was not checked", () => {
    const own = suggest(base, {
      company: SELLER_COMPANY,
      ownInvoice: { status: "found", invoiceId: 1001 },
    });
    expect(own.ownInvoiceId).toBe(1001);
    expect(own.blocking).toEqual([
      "The e-invoice is your own invoice: sevDesk already has invoice 1001 with the same invoice " +
        "number. Booking it as a revenue voucher would count the revenue twice, so it is not " +
        "imported.",
    ]);
    for (const ownInvoice of [{ status: "failed" } as const, undefined]) {
      const unchecked = suggest(base, { company: SELLER_COMPANY, ownInvoice });
      expect(unchecked.ownInvoiceId).toBeUndefined();
      expect(unchecked.blocking.join(" ")).toContain(
        "could not be checked whether sevDesk already",
      );
    }
    expect(suggest(base, { company: SELLER_COMPANY }).blocking).toEqual([]);
    // Expenses are not looked up.
    expect(suggest(base, { ownInvoice: undefined }).blocking).toEqual([]);
  });

  it("does not pick a supplier whose stored IBAN differs from the invoice's payee IBAN", () => {
    const stored = "DE02120300000000202051";
    const rows = [
      {
        contact: contact(1003, "Beispiel Lieferant AG", { vatNumber: "DE000000001" }),
        vatId: "DE000000001",
        iban: stored,
      },
    ];
    const suggestion = suggest(base, { contacts: { rows, scanned: 1, complete: true } });
    expect(suggestion.supplierId).toBeUndefined();
    expect(suggestion.supplierCandidates).toEqual([
      expect.objectContaining({ contactId: 1003, matchedBy: "vat_id" }),
    ]);
    expect(suggestion.warnings).toContain(
      "The invoice's payee IBAN ****3000 differs from the IBAN stored for the matching supplier " +
        "contact 1003 (****2051). Check the bank details with the supplier before paying " +
        "(possible payment redirection); the contact is not chosen automatically.",
    );
    expect(JSON.stringify(suggestion)).not.toContain(stored);
    // The same IBAN, or none stored: picked as before.
    const same = [{ ...rows[0]!, iban: "DE89370400440532013000" }];
    expect(suggest(base, { contacts: { rows: same, scanned: 1, complete: true } }).supplierId).toBe(
      1003,
    );
    const none = [{ ...rows[0]!, iban: undefined }];
    expect(suggest(base, { contacts: { rows: none, scanned: 1, complete: true } }).supplierId).toBe(
      1003,
    );
  });

  describe("an IBAN match alone (review 2026-11, round 3)", () => {
    const IBAN = "DE89370400440532013000";
    const index = (row: { vatId?: string }): ContactIndex => ({
      rows: [{ contact: contact(900, "Factor GmbH"), iban: IBAN, ...row }],
      scanned: 1,
      complete: true,
    });
    const withPayee = (name: string | undefined): ParsedEInvoice =>
      variant((invoice) => {
        invoice.payment.payee = name === undefined ? {} : { name };
      });

    it("is not taken when the invoice names a payee of its own (factoring)", () => {
      // The account in the invoice is the factor's; contact 900 is the factor, not the supplier.
      for (const payee of ["Factor GmbH", "Some Other Payee", undefined]) {
        const suggestion = suggest(withPayee(payee), { contacts: index({}) });
        expect(suggestion.supplierId).toBeUndefined();
        expect(suggestion.supplierCandidates).toEqual([
          expect.objectContaining({ contactId: 900, matchedBy: "iban" }),
        ]);
        expect(suggestion.warnings).toContain(
          "Contact 900 has the invoice's payee IBAN ****3000, but the invoice names a payee of " +
            "its own (BG-10, e.g. a factoring company), so the account is the payee's and does " +
            "not tell who the supplier is. The contact is not chosen automatically: pass the " +
            "supplier's contact, not the payee's.",
        );
        expect(suggestion.warnings.join(" ")).not.toContain("matched by name only");
        expect(suggestion.blocking).toEqual([]);
        expect(JSON.stringify(suggestion.warnings)).not.toContain(IBAN);
      }
    });

    it("is not taken when that contact carries another VAT id than the seller", () => {
      const suggestion = suggest(base, { contacts: index({ vatId: "DE999999999" }) });
      expect(suggestion.supplierId).toBeUndefined();
      expect(suggestion.warnings).toContain(
        "Contact 900 has the invoice's payee IBAN ****3000, but its VAT id differs from the " +
          "seller's VAT id on the invoice, so the account may belong to someone else (e.g. a " +
          "factoring company) or the contact is outdated. The contact is not chosen " +
          "automatically: check the bank details before booking and paying.",
      );
      expect(JSON.stringify(suggestion.warnings)).not.toContain("DE999999999");
    });

    it("is still taken without a separate payee and without a contradicting VAT id", () => {
      // No VAT id stored on the contact.
      expect(suggest(base, { contacts: index({}) }).supplierId).toBe(900);
      // The seller gives no VAT id: nothing to contradict.
      const noSellerVat = variant((invoice) => {
        delete invoice.seller.vatId;
      });
      expect(suggest(noSellerVat, { contacts: index({ vatId: "DE999999999" }) }).supplierId).toBe(
        900,
      );
      // A payee group that only repeats the seller is not a separate payee.
      for (const sellerName of ["Musterlieferant GmbH", "MUSTERLIEFERANT  GmbH."]) {
        expect(suggest(withPayee(sellerName), { contacts: index({}) }).supplierId).toBe(900);
      }
    });

    it("leaves a VAT id match alone, also with a separate payee", () => {
      const rows = [
        { contact: contact(7, "Musterlieferant GmbH"), vatId: "DE000000001" },
        { contact: contact(900, "Factor GmbH"), iban: IBAN, vatId: "DE999999999" },
      ];
      const suggestion = suggest(withPayee("Factor GmbH"), {
        contacts: { rows, scanned: 2, complete: true },
      });
      expect(suggestion.supplierId).toBe(7);
    });
  });

  it("passes the line amount warning on without blocking", () => {
    const suggestion = suggest(
      variant((invoice) => {
        invoice.findings = [{ code: "SD-LINE-NET", severity: "warning", message: "…" }];
      }),
    );
    expect(suggestion.blocking).toEqual([]);
    expect(suggestion.warnings.join(" ")).toContain("finding SD-LINE-NET");
  });

  it("normalizes names for comparison", () => {
    expect(normalizeName("  Muster-Firma   GmbH & Co. KG ")).toBe("muster firma gmbh co kg");
    expect(normalizeName(" -- ")).toBeUndefined();
    expect(normalizeName(undefined)).toBeUndefined();
  });
});

describe("planVoucherFromEInvoice (reads only)", () => {
  const sevClient = (company: Record<string, unknown>): FakeRoute => ({
    path: "/SevClient",
    response: { body: { objects: [{ smallSettlement: "0", ...company }] } },
  });

  it("reads the account once, scans the contacts and matches by VAT id", async () => {
    const client = new FakeSevdeskClient([
      sevClient({ name: "Musterfirma GmbH", vatNumber: "DE000000000" }),
      { path: "/Contact", response: { fixture: "contacts/contacts-list.json" } },
    ]);
    const suggestion = await planVoucherFromEInvoice(base, { client, cacheOwner: {} });
    expect(client.writes()).toEqual([]);
    expect(client.callsTo("/SevClient")).toHaveLength(1);
    expect(client.callsTo("/Contact")[0]?.query).toMatchObject({
      depth: "1",
      limit: 1000,
      offset: 0,
    });
    expect(suggestion).toMatchObject({
      kind: "expense",
      supplierId: 1003,
      supplierCandidates: [{ contactId: 1003, matchedBy: "vat_id", customerNumber: "L-2001" }],
      supplierSearch: { complete: true },
      taxRuleId: 9,
    });
  });

  it("falls back to a name search when the scan is cut off", async () => {
    const template = (
      loadFixture("contacts/contacts-list.json").body as { objects: Record<string, unknown>[] }
    ).objects[0]!;
    const many = Array.from({ length: MAX_SCANNED_CONTACTS + 1 }, (_unused, index) => ({
      ...template,
      id: String(10_000 + index),
      name: `Kontakt ${String(index)}`,
      vatNumber: null,
    }));
    const found = { ...template, id: "99999", name: "Musterlieferant GmbH", vatNumber: null };
    const client = new FakeSevdeskClient([
      {
        path: "/Contact",
        query: { name: "Musterlieferant GmbH" },
        response: { body: { objects: [found, many[0]] } },
      },
      { path: "/Contact", response: { body: { objects: many } } },
    ]);
    const index = await loadContactIndex(client, base.seller);
    expect(index.complete).toBe(false);
    expect(index.scanned).toBe(MAX_SCANNED_CONTACTS + 1);
    expect(index.rows.at(-1)?.contact.id).toBe(99999);
    expect(client.callsTo("/Contact").at(-1)?.query).toMatchObject({
      name: "Musterlieferant GmbH",
      limit: 100,
    });
  });

  it("looks a revenue invoice up by number and blocks a match", async () => {
    const invoiceRow = (loadFixture("invoices/invoice-1001.json").body as { objects: Row[] })
      .objects[0]!;
    const client = new FakeSevdeskClient([
      sevClient({ vatNumber: "DE000000001" }),
      { path: "/Contact", response: { body: { objects: [] } } },
      {
        path: "/Invoice",
        query: { invoiceNumber: "RE-2026-0001" },
        response: { body: { objects: [{ ...invoiceRow, invoiceNumber: "RE-2026-0001" }] } },
      },
    ]);
    const suggestion = await planVoucherFromEInvoice(base, { client, cacheOwner: {} });
    expect(suggestion).toMatchObject({ kind: "revenue", ownInvoiceId: 1001 });
    expect(client.writes()).toEqual([]);
    expect(client.callsTo("/Invoice")[0]?.query).toMatchObject({
      invoiceNumber: "RE-2026-0001",
    });
  });

  it("blocks revenue when the lookup fails and rethrows a cancellation", async () => {
    const routesWith = (error: SevdeskError): FakeRoute[] => [
      sevClient({ vatNumber: "DE000000001" }),
      { path: "/Contact", response: { body: { objects: [] } } },
      { path: "/Invoice", response: { error } },
    ];
    const failed = await planVoucherFromEInvoice(base, {
      client: new FakeSevdeskClient(routesWith(new SevdeskError({ kind: "server", message: "x" }))),
      cacheOwner: {},
    });
    expect(failed.blocking.join(" ")).toContain("could not be checked");
    await expect(
      findOwnInvoice(
        new FakeSevdeskClient(routesWith(new SevdeskError({ kind: "aborted", message: "x" }))),
        "RE-1",
      ),
    ).rejects.toMatchObject({ kind: "aborted" });
    await expect(
      findOwnInvoice(
        new FakeSevdeskClient([{ path: "/Invoice", response: { body: { objects: [] } } }]),
        "RE-1",
      ),
    ).resolves.toEqual({ status: "none" });
  });

  it("works without readable account settings", async () => {
    const client = new FakeSevdeskClient([
      { path: "/SevClient", response: { body: { objects: [{}] } } },
      { path: "/Contact", response: { body: { objects: [] } } },
    ]);
    const suggestion = await planVoucherFromEInvoice(base, { client, cacheOwner: {} });
    expect(suggestion.kindBasis).toBe("assumed_expense");
    expect(suggestion.warnings.join(" ")).toContain("could not be read");
  });
});
