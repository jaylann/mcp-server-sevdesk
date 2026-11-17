import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Tier } from "../../../../src/safety/tiers.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { creditNoteCreateDraftTool } from "../../../../src/tools/credit-notes/draft-create.js";
import { creditNoteUpdateDraftTool as tool } from "../../../../src/tools/credit-notes/draft-update.js";
import { creditNoteFromInvoiceTool } from "../../../../src/tools/credit-notes/from-invoice.js";
import { resetTool } from "../../../../src/tools/lifecycle/reset.js";
import { selectTools } from "../../../../src/tools/registry.js";
import { testConfig } from "../../../helpers/config.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  creditNoteUpdateRoutes as routes,
  notFound,
  saveCreditNoteRoute,
  smallBusinessAccountRoute,
  TIMESTAMPS,
  withRoutes,
} from "./routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

/** The stored draft 2202 with some fields replaced. */
function storedDraft(fields: Record<string, unknown>): FakeRoute {
  const stored = loadFixture("drafts/credit-note-2202-draft.json").body as {
    objects: Record<string, unknown>[];
  };
  return {
    path: "/CreditNote/2202",
    response: { body: { objects: [{ ...stored.objects[0], ...fields }] } },
  };
}

/** A provision credit note (tax rule 9) without a source invoice. */
const provision = storedDraft({
  bookingCategory: "PROVISION",
  refSrcInvoice: null,
  origin: null,
  taxRule: { id: "9", objectName: "TaxRule" },
});

async function prepare(args: unknown, table: readonly FakeRoute[] = routes) {
  const client = new FakeSevdeskClient(table);
  return { client, plan: await prepareWrite(tool, args, client) };
}

async function rejection(args: unknown, table: readonly FakeRoute[] = routes) {
  const client = new FakeSevdeskClient(table);
  const error = await prepareWrite(tool, args, client).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect(client.writes()).toEqual([]);
  return error as SevdeskError;
}

/** Every stored field carried over (fixture credit-note-2202-draft.json). */
const carriedCreditNote = {
  id: 2202,
  objectName: "CreditNote",
  mapAll: true,
  creditNoteNumber: "GU-1003",
  creditNoteType: "CN",
  status: 100,
  contact: { id: 1001, objectName: "Contact" },
  contactPerson: { id: 7001, objectName: "SevUser" },
  creditNoteDate: "02.11.2026",
  deliveryDate: TIMESTAMPS["2026-11-02"],
  header: "Gutschrift zu RE-1001",
  headText: "Wir schreiben Ihnen gut:",
  footText: "Der Betrag wird verrechnet.",
  discount: 0,
  currency: "EUR",
  showNet: true,
  taxRule: { id: 1, objectName: "TaxRule" },
  taxRate: 0,
  smallSettlement: false,
  bookingCategory: "UNDERACHIEVEMENT",
  refSrcInvoice: { id: 1001, objectName: "Invoice" },
  addressName: "Musterfirma GmbH, Buchhaltung",
  addressStreet: "Musterstraße 1",
  addressZip: "12345",
  addressCity: "Musterstadt",
  addressCountry: { id: 1, objectName: "StaticCountry" },
  customerInternalNote: "Reklamation 17",
  origin: { id: 1001, objectName: "Invoice" },
};

describe("sevdesk_credit_note_update_draft (recorded update shape, fake data)", () => {
  it("is a write-tier update tool in the credit-notes toolset with explicit annotations", () => {
    expect(tool.tier).toBe("write");
    expect(tool.toolset).toBe("credit-notes");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("is named by the tools that leave a credit note draft behind", () => {
    for (const other of [
      creditNoteCreateDraftTool,
      creditNoteFromInvoiceTool,
      resetTool("creditNote"),
    ]) {
      expect(other.description).toContain("sevdesk_credit_note_update_draft");
    }
  });

  it("is registered only when the write tier is allowed", () => {
    const listed = (tiers: Tier[]) =>
      selectTools([tool], testConfig({ allowedTiers: new Set<Tier>(tiers) })).length;
    expect(listed(["read"])).toBe(0);
    expect(listed(["read", "write"])).toBe(1);
  });

  it("changes one field and carries every stored field over, positions untouched", async () => {
    const { client, plan } = await prepare({ id: 2202, header: "Gutschrift Reklamation 17" });
    expect(client.writes()).toEqual([]);
    expect(plan.state.body).toEqual({
      creditNote: { ...carriedCreditNote, header: "Gutschrift Reklamation 17" },
      creditNotePosSave: [],
      creditNotePosDelete: null,
    });
    expect(plan.state.creditNoteId).toBe(2202);
    expect(plan.preview.action).toBe(
      "Update draft credit note 2202 for Musterfirma GmbH (contact 1001): change title.",
    );
    expect(plan.preview.facts).toEqual([
      { label: "Credit note", value: "2202 (number GU-1003, draft)" },
      { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
      { label: "Booking category", value: "UNDERACHIEVEMENT" },
      { label: "Reduces invoice", value: "1001" },
      { label: "Title", value: "Gutschrift zu RE-1001 → Gutschrift Reklamation 17" },
      { label: "Total (unchanged)", value: "gross 47.60 EUR" },
    ]);
    // Nothing the source invoice's checks depend on changed: it is not read, no number is peeked.
    expect(client.callsTo("/Invoice/1001")).toEqual([]);
    expect(client.callsTo("/CreditNote/Factory/getNextCreditNoteNumber")).toEqual([]);
    expect(client.callsTo("/SevUser")).toEqual([]);
  });

  it("keeps origin, refSrcInvoice, type and number of a credit note made from an invoice", async () => {
    const { plan } = await prepare({ id: 2202, footText: "Neu" });
    expect(plan.state.body.creditNote).toMatchObject({
      origin: { id: 1001, objectName: "Invoice" },
      refSrcInvoice: { id: 1001, objectName: "Invoice" },
      creditNoteType: "CN",
      creditNoteNumber: "GU-1003",
    });
    // discountTime was null: nothing is sent (sevDesk then stores "0", D-110).
    expect(plan.state.body.creditNote).not.toHaveProperty("discountTime");
  });

  it("changes the date, one address field and the contact person, keeping the rest", async () => {
    const { client, plan } = await prepare({
      id: 2202,
      date: "2026-11-03",
      addressStreet: "Neue Straße 2",
      contactPersonId: 2001,
    });
    expect(plan.state.body.creditNote).toEqual({
      ...carriedCreditNote,
      creditNoteDate: "03.11.2026",
      // The stored delivery date (2026-11-02) stays; it does not follow the new date.
      deliveryDate: TIMESTAMPS["2026-11-02"],
      addressStreet: "Neue Straße 2",
      address: "Musterfirma GmbH, Buchhaltung\nNeue Straße 2\n12345 Musterstadt",
      contactPerson: { id: 2001, objectName: "SevUser" },
    });
    expect(plan.state.body.creditNotePosSave).toEqual([]);
    expect(plan.preview.facts).toEqual([
      { label: "Credit note", value: "2202 (number GU-1003, draft)" },
      { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
      { label: "Booking category", value: "UNDERACHIEVEMENT" },
      { label: "Reduces invoice", value: "1001" },
      {
        label: "Address",
        value:
          "Musterfirma GmbH, Buchhaltung, Musterstraße 1, 12345 Musterstadt, Deutschland → " +
          "Musterfirma GmbH, Buchhaltung, Neue Straße 2, 12345 Musterstadt, Deutschland",
      },
      { label: "Credit note date", value: "2026-11-02 → 2026-11-03" },
      { label: "Contact person", value: "user 7001 → Erika Musterfrau (user 2001)" },
      { label: "Total (unchanged)", value: "gross 47.60 EUR" },
    ]);
    // None of these changes needs the source invoice re-checked.
    expect(client.callsTo("/Invoice/1001")).toEqual([]);
  });

  it("carries a stored cash discount and payment method over", async () => {
    const withTerms = storedDraft({
      discount: "2",
      discountTime: "7",
      paymentMethod: { id: "21919", objectName: "PaymentMethod" },
    });
    const { plan } = await prepare({ id: 2202, headText: "Hallo" }, withRoutes(routes, withTerms));
    expect(plan.state.body.creditNote).toMatchObject({
      discount: 2,
      discountTime: 7,
      paymentMethod: { id: 21919, objectName: "PaymentMethod" },
    });
  });

  describe("positions", () => {
    it("replaces all positions in one request and checks them against the source invoice", async () => {
      const { client, plan } = await prepare({
        id: 2202,
        positions: [{ name: "Preisnachlass", quantity: 2, unitPrice: 25, taxRate: 19 }],
      });
      expect(plan.state.body.creditNotePosSave).toEqual([
        {
          objectName: "CreditNotePos",
          mapAll: true,
          quantity: 2,
          price: "25.00",
          name: "Preisnachlass",
          unity: { id: 1, objectName: "Unity" },
          taxRate: 19,
          positionNumber: 0,
        },
      ]);
      expect(plan.state.body.creditNotePosDelete).toEqual([
        { id: 6301, objectName: "CreditNotePos" },
        { id: 6302, objectName: "CreditNotePos" },
      ]);
      expect(plan.state.expected).toEqual({ net: "50.00", tax: "9.50", gross: "59.50" });
      expect(plan.preview.facts).toContainEqual({
        label: "Reduces invoice",
        value: "1001 (RE-1001)",
      });
      expect(plan.preview.facts).toContainEqual({
        label: "Positions",
        value: "replace 2 positions with 1 position",
      });
      expect(client.callsTo("/Invoice/1001")).toHaveLength(1);
    });

    it("adds a position by passing the full new list", async () => {
      const { plan } = await prepare({
        id: 2202,
        positions: [
          { name: "Preisnachlass Lieferung", quantity: 1, unitPrice: 30 },
          { name: "Versandkosten", quantity: 1, unitPrice: 10 },
          { name: "Kulanz", quantity: 1, unitPrice: 5 },
        ],
      });
      expect(plan.state.body.creditNotePosSave.map((row) => [row.name, row.taxRate])).toEqual([
        ["Preisnachlass Lieferung", 19],
        ["Versandkosten", 19],
        ["Kulanz", 19],
      ]);
      expect(plan.state.body.creditNotePosDelete).toHaveLength(2);
      expect(plan.preview.facts).toContainEqual({
        label: "Positions",
        value: "replace 2 positions with 3 positions",
      });
    });

    it("removes a position by passing the rest", async () => {
      const { plan } = await prepare({
        id: 2202,
        positions: [{ name: "Preisnachlass Lieferung", quantity: 1, unitPrice: 30 }],
      });
      expect(plan.state.body.creditNotePosSave).toHaveLength(1);
      expect(plan.state.body.creditNotePosDelete).toEqual([
        { id: 6301, objectName: "CreditNotePos" },
        { id: 6302, objectName: "CreditNotePos" },
      ]);
      expect(plan.preview.facts).toContainEqual({
        label: "Total (expected)",
        value: "net 30.00 EUR, tax 5.70 EUR, gross 35.70 EUR",
      });
    });

    it("warns that stored document discounts are left out of the expected total", async () => {
      const discounted = withRoutes(routes, storedDraft({ sumDiscounts: "-10" }));
      const replaced = await prepare(
        { id: 2202, positions: [{ name: "Preisnachlass", quantity: 1, unitPrice: 30 }] },
        discounted,
      );
      expect(replaced.plan.preview.warnings).toContainEqual(
        "The draft has document discounts (Rabatte) that stay on it: sevDesk applies them to " +
          "the new positions, so the saved total will differ from the expected total, which " +
          "leaves them out. Check the total after the save.",
      );
      // Kept positions show the stored total, which already includes the discounts.
      const kept = await prepare({ id: 2202, header: "Neu" }, discounted);
      expect(kept.plan.preview.warnings.join(" ")).not.toContain("Rabatte");
      // A stored zero (the fixture) warns about nothing.
      const plain = await prepare({
        id: 2202,
        positions: [{ name: "Preisnachlass", quantity: 1, unitPrice: 30 }],
      });
      expect(plain.plan.preview.warnings.join(" ")).not.toContain("Rabatte");
    });

    it("saves positions on a draft that has none, deleting nothing", async () => {
      const empty: FakeRoute = {
        path: "/CreditNotePos",
        query: { "creditNote[id]": 2202 },
        response: { body: { objects: [] } },
      };
      const { plan } = await prepare(
        { id: 2202, positions: [{ name: "A", quantity: 1, unitPrice: 1 }] },
        withRoutes(routes, empty),
      );
      expect(plan.state.body.creditNotePosSave).toHaveLength(1);
      expect(plan.state.body.creditNotePosDelete).toBeNull();
    });
  });

  it("saves once, reserves no number, reads the credit note back and reports it as affected", async () => {
    const client = new FakeSevdeskClient(routes);
    const { output } = await executeWrite(tool, { id: 2202, header: "Neu" }, client);
    expect(
      client.writes().map(({ method, path, query, tier }) => ({ method, path, query, tier })),
    ).toEqual([
      { method: "POST", path: "/CreditNote/Factory/saveCreditNote", query: {}, tier: "write" },
    ]);
    expect(client.writes()[0]?.body).toMatchObject({
      creditNote: { id: 2202, header: "Neu", creditNoteNumber: "GU-1003" },
      creditNotePosSave: [],
      creditNotePosDelete: null,
    });
    expect(output.affected).toEqual([{ objectName: "CreditNote", id: "2202" }]);
    expect(output.data.creditNote).toMatchObject({
      id: 2202,
      number: "GU-1003",
      status: { code: 100 },
      bookingCategory: { code: "UNDERACHIEVEMENT" },
      sourceInvoiceId: 1001,
    });
    expect(output.data.positions).toHaveLength(2);
    expect(output.summary).toBe("Updated draft credit note 2202 (2 positions, gross 47.60 EUR).");
    expect(output.data.notes).toBeUndefined();
  });

  it("keeps a missing number missing and says so after the save", async () => {
    const numberless = storedDraft({ creditNoteNumber: null });
    const client = new FakeSevdeskClient(withRoutes(routes, numberless));
    const { output } = await executeWrite(tool, { id: 2202, header: "Neu" }, client);
    expect(client.writes()[0]?.body).not.toHaveProperty("creditNote.creditNoteNumber");
    expect(client.callsTo("/CreditNote/Factory/getNextCreditNoteNumber")).toEqual([]);
    expect(output.data.notes).toEqual([
      expect.stringMatching(/^The credit note has no number, and sevdesk_credit_note_finalize/),
    ]);
  });

  it("fails loudly when sevDesk saved a different credit note", async () => {
    const client = new FakeSevdeskClient(withRoutes(routes, saveCreditNoteRoute));
    const error = await executeWrite(tool, { id: 2202, header: "Neu" }, client).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).message).toBe(
      "sevDesk saved credit note 2201 instead of updating credit note 2202. Check both drafts " +
        "in sevDesk and delete the extra one there before repeating the call.",
    );
    expect((error as SevdeskError).completedWrites).toEqual([
      { objectName: "CreditNote", id: "2201" },
    ]);
  });

  describe("provision credit notes", () => {
    it("keep tax rule 9 and need no source invoice", async () => {
      const { client, plan } = await prepare(
        { id: 2202, positions: [{ name: "Provision", quantity: 1, unitPrice: 100, taxRate: 19 }] },
        withRoutes(routes, provision),
      );
      expect(plan.state.body.creditNote).toMatchObject({
        bookingCategory: "PROVISION",
        taxRule: { id: 9, objectName: "TaxRule" },
      });
      expect(plan.state.body.creditNote).not.toHaveProperty("refSrcInvoice");
      expect(plan.preview.facts.map((entry) => entry.label)).not.toContain("Reduces invoice");
      expect(client.callsTo("/Invoice/1001")).toEqual([]);
    });

    it("refuse a sales tax rule", async () => {
      const error = await rejection({ id: 2202, taxRuleId: 1 }, withRoutes(routes, provision));
      expect(error.message).toBe(
        "Tax rule 1 (Umsatzsteuerpflichtige Umsätze) cannot be used for provision credit notes. " +
          "Use tax rule 9; sevdesk_reference_lookup kind=tax_rules explains them.",
      );
    });

    it("take the Kleinunternehmer rules and warn on such an account", async () => {
      const { plan } = await prepare(
        {
          id: 2202,
          taxRuleId: 10,
          positions: [{ name: "Provision", quantity: 1, unitPrice: 100, taxRate: 0 }],
        },
        withRoutes(routes, provision, smallBusinessAccountRoute),
      );
      expect(plan.state.body.creditNote).toMatchObject({
        taxRule: { id: 10, objectName: "TaxRule" },
      });
      expect(plan.preview.warnings).toContainEqual(
        expect.stringMatching(/^On a Kleinunternehmer account provision credit notes take/),
      );
    });

    it("point a kept rule 9 to their own Kleinunternehmer rule, not to rule 11", async () => {
      const { plan } = await prepare(
        { id: 2202, header: "Provision Oktober" },
        withRoutes(routes, provision, smallBusinessAccountRoute),
      );
      expect(plan.preview.warnings).toContainEqual(
        "The draft keeps tax rule 9 (Vorsteuerabziehbare Aufwendungen), which does not fit this " +
          "account's VAT regulation (the Kleinunternehmer regulation (§19 UStG)): sevDesk will " +
          "refuse to finalize it. Pass taxRuleId 10 (Nicht vorsteuerabziehbare Aufwendungen) " +
          "with 0 % rates to fix it.",
      );
      expect(plan.preview.warnings.join(" ")).not.toContain("taxRuleId 11");
    });
  });

  describe("re-checks the source invoice when the change depends on it", () => {
    it("refuses a rate the source invoice does not have", async () => {
      const error = await rejection({
        id: 2202,
        positions: [{ name: "A", quantity: 1, unitPrice: 1, taxRate: 7 }],
      });
      expect(error.message).toBe(
        "Position 1 has a tax rate of 7 %, but the source invoice 1001 only has 19 %; sevDesk " +
          "only accepts those rates here.",
      );
    });

    it("refuses a contact the source invoice does not belong to", async () => {
      const error = await rejection({ id: 2202, contactId: 1002 });
      expect(error.message).toBe(
        "Invoice 1001 belongs to contact 1001, not to contact 1002. Use the invoice's contact.",
      );
    });

    it("refuses another currency than the source invoice's", async () => {
      const error = await rejection({ id: 2202, currency: "CHF" });
      expect(error.message).toBe(
        "The source invoice 1001 is in EUR; the credit note must use the same currency.",
      );
    });

    it("refuses a tax rule that does not fit the account, naming the invoice's rates", async () => {
      const error = await rejection(
        { id: 2202, taxRuleId: 1 },
        withRoutes(routes, smallBusinessAccountRoute),
      );
      expect(error.message).toMatch(
        /An underachievement credit note must keep the rates of the invoice it reduces \(invoice 1001: 19 %\)/,
      );
    });

    it("refuses when the source invoice no longer exists", async () => {
      const error = await rejection(
        { id: 2202, positions: [{ name: "A", quantity: 1, unitPrice: 1 }] },
        withRoutes(routes, notFound("/Invoice/1001")),
      );
      expect(error.message).toBe(
        "The source invoice 1001 of credit note 2202 does not exist any more, so the change " +
          "cannot be checked against it. Check the credit note in sevDesk.",
      );
    });

    it("reads the source invoice of a credit note that only has refSrcInvoice", async () => {
      const linked = storedDraft({ origin: null });
      const { client } = await prepare(
        { id: 2202, positions: [{ name: "A", quantity: 1, unitPrice: 1 }] },
        withRoutes(routes, linked),
      );
      expect(client.callsTo("/Invoice/1001")).toHaveLength(1);
    });

    it("reads the origin invoice of a credit note without refSrcInvoice", async () => {
      const fromInvoice = storedDraft({ refSrcInvoice: null });
      const { client, plan } = await prepare(
        { id: 2202, positions: [{ name: "A", quantity: 1, unitPrice: 1 }] },
        withRoutes(routes, fromInvoice),
      );
      expect(client.callsTo("/Invoice/1001")).toHaveLength(1);
      expect(plan.state.body.creditNote).not.toHaveProperty("refSrcInvoice");
      expect(plan.state.body.creditNote.origin).toEqual({ id: 1001, objectName: "Invoice" });
    });
  });

  describe("refuses before sending anything", () => {
    it.each([
      [
        "nothing to change",
        { id: 2202 },
        "Nothing to change: give at least one field of the credit note besides id.",
      ],
      [
        "a new price mode without positions",
        { id: 2202, priceMode: "gross" },
        "Changing priceMode from net to gross would make sevDesk read every stored price as " +
          "gross. Pass the positions again with prices in the new mode.",
      ],
      [
        "a delivery period that ends before it starts",
        { id: 2202, deliveryDateUntil: "2026-11-01" },
        "deliveryDateUntil 2026-11-01 is before the delivery date 2026-11-02.",
      ],
    ])("%s", async (_label, args, message) => {
      const error = await rejection(args);
      expect(error.kind).toBe("validation");
      expect(error.message).toBe(message);
    });

    it.each([
      [
        "an open credit note",
        { status: "200" },
        'Credit note 2202 is not a draft (status: Open / delivered); only drafts can be changed. Reset an open one to a draft first with sevdesk_credit_note_reset (to: "draft").',
      ],
      [
        "an enshrined credit note",
        { enshrined: "2026-11-05T10:00:00+01:00" },
        "Credit note 2202 is enshrined (festgeschrieben) and can no longer be changed.",
      ],
      [
        "another credit note type",
        { creditNoteType: "XX" },
        "Credit note 2202 is not a regular credit note (type CN); this tool only changes those. Edit it in sevDesk.",
      ],
      [
        "a booking category it does not write",
        { bookingCategory: "ACCOUNTING_TYPE" },
        "Credit note 2202 has a booking category this tool does not write (it writes underachievement, provision, royalty_assigned and royalty_unassigned). Edit it in sevDesk.",
      ],
      [
        "a credit note without a booking category",
        { bookingCategory: null },
        "Credit note 2202 has a booking category this tool does not write (it writes underachievement, provision, royalty_assigned and royalty_unassigned). Edit it in sevDesk.",
      ],
    ])("%s", async (_label, fields, message) => {
      const error = await rejection(
        { id: 2202, header: "Neu" },
        withRoutes(routes, storedDraft(fields)),
      );
      expect(error.message).toBe(message);
    });

    it("a credit note that does not exist", async () => {
      const error = await rejection(
        { id: 2202, header: "Neu" },
        withRoutes(routes, notFound("/CreditNote/2202")),
      );
      expect(error.message).toBe(
        "Credit note 2202 does not exist in sevDesk. Find the right id with " +
          "sevdesk_credit_notes_list.",
      );
    });

    it("a stored position list it cannot read completely", async () => {
      const page: FakeRoute = {
        path: "/CreditNotePos",
        query: { "creditNote[id]": 2202 },
        // One page answered for every offset with rows of another credit note: the reader pages
        // to its cap and reports the rows as incomplete.
        response: {
          body: {
            objects: [
              {
                id: "6301",
                objectName: "CreditNotePos",
                creditNote: { id: "9999", objectName: "CreditNote" },
              },
            ],
            total: "20000",
          },
        },
      };
      const error = await rejection({ id: 2202, header: "Neu" }, withRoutes(routes, page));
      expect(error.message).toBe(
        "The credit note 2202 has more positions than this server reads at once, so it cannot " +
          "be updated safely here. Edit it in sevDesk.",
      );
    });
  });
});
