import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { creditNoteCreateDraftTool as tool } from "../../../../src/tools/credit-notes/draft-create.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  creditNoteCreateArgs as args,
  creditNoteCreateRoutes as routes,
  notFound,
  TIMESTAMPS,
  withRoutes,
} from "./routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

async function prepare(callArgs: unknown, table: readonly FakeRoute[] = routes) {
  const client = new FakeSevdeskClient(table);
  return { client, plan: await prepareWrite(tool, callArgs, client) };
}

async function rejection(callArgs: unknown, table: readonly FakeRoute[] = routes) {
  const client = new FakeSevdeskClient(table);
  const error = await prepareWrite(tool, callArgs, client).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect(client.writes()).toEqual([]);
  return error as SevdeskError;
}

/** A credit note that already reduces invoice 1001 (underachievement, refSrcInvoice). */
const existingCreditNote: FakeRoute = {
  path: "/CreditNote",
  query: { "contact[id]": 1001 },
  response: {
    body: {
      objects: [
        {
          id: "2150",
          objectName: "CreditNote",
          status: "100",
          refSrcInvoice: { id: "1001", objectName: "Invoice" },
        },
        {
          id: "2151",
          objectName: "CreditNote",
          status: "100",
          refSrcInvoice: { id: "1002", objectName: "Invoice" },
        },
      ],
    },
  },
};

/** Invoice 1001 with other fields, as `GET /Invoice/1001?embed=contact` returns it. */
function sourceInvoice(fields: Record<string, unknown>): FakeRoute {
  const stored = loadFixture("invoices/invoice-1001.json").body as {
    objects: Record<string, unknown>[];
  };
  return {
    path: "/Invoice/1001",
    query: { embed: "contact" },
    response: { body: { objects: [{ ...stored.objects[0], ...fields }] } },
  };
}

describe("sevdesk_credit_note_create_draft (community: sevdesk-rs request shape + recorded response, fake data)", () => {
  it("is a write-tier create tool in the credit-notes toolset", () => {
    expect(tool.tier).toBe("write");
    expect(tool.toolset).toBe("credit-notes");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("prepares sevdesk-rs's underachievement body with the peeked number: source invoice, its rule and rate", async () => {
    const { client, plan } = await prepare(args);
    expect(client.writes()).toEqual([]);
    expect(client.callsTo("/CreditNote/Factory/getNextCreditNoteNumber")).toMatchObject([
      { query: { useNextNumber: "false" }, sideEffect: false },
    ]);
    expect(plan.state.body).toEqual({
      creditNote: {
        objectName: "CreditNote",
        mapAll: true,
        creditNoteNumber: "GU-1002",
        creditNoteType: "CN",
        status: 100,
        contact: { id: 1001, objectName: "Contact" },
        contactPerson: { id: 2001, objectName: "SevUser" },
        creditNoteDate: "07.11.2026",
        deliveryDate: TIMESTAMPS["2026-11-07"],
        header: "Gutschrift",
        discount: 0,
        currency: "EUR",
        showNet: true,
        taxRule: { id: 1, objectName: "TaxRule" },
        taxRate: 0,
        taxText: "Umsatzsteuerpflichtige Umsätze",
        smallSettlement: false,
        bookingCategory: "UNDERACHIEVEMENT",
        refSrcInvoice: { id: 1001, objectName: "Invoice" },
        addressName: "Musterfirma GmbH, Buchhaltung",
        addressStreet: "Musterstraße 1",
        addressZip: "12345",
        addressCity: "Musterstadt",
        addressCountry: { id: 1, objectName: "StaticCountry" },
      },
      creditNotePosSave: [
        {
          objectName: "CreditNotePos",
          mapAll: true,
          quantity: 1,
          price: "10.00",
          name: "Teilgutschrift Versand",
          unity: { id: 1, objectName: "Unity" },
          taxRate: 19,
          positionNumber: 0,
        },
      ],
      creditNotePosDelete: null,
    });
    expect(plan.preview.action).toBe(
      "Create a draft credit note (Gutschrift, UNDERACHIEVEMENT) for Musterfirma GmbH (contact " +
        "1001) with 1 position, gross 11.90 EUR.",
    );
    expect(plan.preview.facts.slice(0, 4)).toEqual([
      { label: "Number", value: "GU-1002 (reserved when the draft is saved)" },
      { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
      { label: "Booking category", value: "UNDERACHIEVEMENT" },
      { label: "Reduces invoice", value: "1001 (RE-1001)" },
    ]);
    expect(plan.preview.warnings).toContain(
      "Saving reserves the number GU-1002 from sevDesk's credit note number range " +
        "(Nummernkreis). If saving fails, that number is skipped (a gap in the range); if " +
        "another document takes it first, the draft gets the next number.",
    );
  });

  it("reserves the number, saves once with it and the write tier, and returns the credit note read back", async () => {
    const client = new FakeSevdeskClient(routes);
    const { output } = await executeWrite(tool, args, client);
    expect(
      client.writes().map(({ method, path, query, tier }) => ({ method, path, query, tier })),
    ).toEqual([
      {
        method: "GET",
        path: "/CreditNote/Factory/getNextCreditNoteNumber",
        query: { useNextNumber: "true" },
        tier: "write",
      },
      { method: "POST", path: "/CreditNote/Factory/saveCreditNote", query: {}, tier: "write" },
    ]);
    expect(client.writes()[1]?.body).toMatchObject({ creditNote: { creditNoteNumber: "GU-1002" } });
    // The number scan reads every credit note (no filter sevDesk might ignore), after reserving.
    const scan = client.calls.filter(
      (call) => call.path === "/CreditNote" && !("contact[id]" in call.query),
    );
    expect(scan.map((call) => call.query)).toEqual([
      { limit: 1000, offset: 0, countAll: true },
      { limit: 1000, offset: 3, countAll: true },
    ]);
    expect(client.calls.indexOf(scan[0] as (typeof client.calls)[number])).toBeGreaterThan(
      client.calls.findIndex((call) => call.query["useNextNumber"] === "true"),
    );
    expect(output.affected).toEqual([{ objectName: "CreditNote", id: "2201" }]);
    expect(output.data.creditNote).toMatchObject({
      id: 2201,
      status: { code: 100 },
      bookingCategory: { code: "UNDERACHIEVEMENT" },
      sourceInvoiceId: 1001,
      totals: { gross: { amount: "11.90", currency: "EUR" } },
    });
    expect(output.data.positions).toHaveLength(1);
    expect(output.data.creditNote.number).toBe("GU-1002");
    expect(output.summary).toBe("Created draft credit note 2201 (1 position, gross 11.90 EUR).");
    expect(output.data.notes).toBeUndefined();
  });

  it("uses tax rule 9 for a provision credit note without a source invoice", async () => {
    const { client, plan } = await prepare({
      contactId: 1001,
      bookingCategory: "provision",
      positions: [{ name: "Provision Oktober", quantity: 1, unitPrice: 100, taxRate: 19 }],
    });
    expect(plan.state.body.creditNote).toMatchObject({
      bookingCategory: "PROVISION",
      taxRule: { id: 9, objectName: "TaxRule" },
      taxText: "Vorsteuerabziehbare Aufwendungen",
    });
    expect(plan.state.body.creditNote).not.toHaveProperty("refSrcInvoice");
    expect(client.callsTo("/Invoice/1001")).toEqual([]);
  });

  it("warns that royalty credit notes are not verified", async () => {
    const { plan } = await prepare({
      contactId: 1001,
      bookingCategory: "royalty_assigned",
      positions: [{ name: "Lizenz", quantity: 1, unitPrice: 50, taxRate: 7 }],
    });
    expect(plan.state.body.creditNote.bookingCategory).toBe("ROYALTY_ASSIGNED");
    expect(plan.preview.warnings).toContain(
      "sevDesk's requirements for royalty credit notes (tax rule, accounts) are not documented " +
        "or recorded; check the draft in sevDesk before finalizing.",
    );
    expect(plan.preview.warnings).toHaveLength(2);
  });

  it("creates another credit note for the source invoice with allowDuplicate, and says so", async () => {
    const { plan } = await prepare(
      { ...args, allowDuplicate: true },
      withRoutes(routes, existingCreditNote),
    );
    expect(plan.preview.warnings).toContain(
      "Creating another one (allowDuplicate): credit note 2150 exists already.",
    );
  });

  it("passes the creditability warnings of the source invoice on", async () => {
    const paidNothing = sourceInvoice({ status: "1000", paidAmount: 0 });
    const { plan } = await prepare(args, withRoutes(routes, paidNothing));
    expect(plan.preview.warnings[0]).toBe(
      "The invoice is marked paid but sevDesk shows no payment on it; make sure it was not " +
        "settled another way before crediting it.",
    );
  });

  it("warns when not every credit note could be checked", async () => {
    // A recorded single page answered for every offset: the scan stops at its cap.
    const endless: FakeRoute = {
      path: "/CreditNote",
      query: { "contact[id]": 1001 },
      response: {
        body: {
          objects: [
            {
              id: "2151",
              objectName: "CreditNote",
              status: "100",
              refSrcInvoice: { id: "1002", objectName: "Invoice" },
            },
          ],
          total: "99999",
        },
      },
    };
    const { plan } = await prepare(args, withRoutes(routes, endless));
    expect(plan.preview.warnings).toContain(
      "Not every credit note could be checked for an earlier one from this invoice.",
    );
  });

  it("takes the source invoice's currency by default", async () => {
    const usd = sourceInvoice({ currency: "USD" });
    const { plan } = await prepare(args, withRoutes(routes, usd));
    expect(plan.state.body.creditNote.currency).toBe("USD");
    expect(plan.preview.warnings).toContain(
      "The document is in USD. Foreign-currency drafts are not verified against a live sevDesk " +
        "account yet; check the amounts in sevDesk before finalizing.",
    );
  });

  describe("refuses before sending anything", () => {
    it.each([
      [
        "underachievement without a source invoice",
        { ...args, sourceInvoiceId: undefined },
        "bookingCategory underachievement needs sourceInvoiceId: the finalized invoice the " +
          "credit note reduces. To credit a whole invoice use sevdesk_credit_note_create_from_invoice.",
      ],
      [
        "a source invoice with another category",
        { ...args, bookingCategory: "provision" },
        "sourceInvoiceId and allowDuplicate only apply to bookingCategory underachievement (a " +
          "credit note that reduces an invoice).",
      ],
      [
        "allowDuplicate with another category",
        {
          contactId: 1001,
          bookingCategory: "provision",
          allowDuplicate: true,
          positions: args.positions,
        },
        "sourceInvoiceId and allowDuplicate only apply to bookingCategory underachievement (a " +
          "credit note that reduces an invoice).",
      ],
      [
        "a rate the source invoice does not have",
        { ...args, positions: [{ name: "A", quantity: 1, unitPrice: 1, taxRate: 7 }] },
        "Position 1 has a tax rate of 7 %, but the source invoice 1001 only has 19 %; sevDesk " +
          "only accepts those rates here.",
      ],
      [
        "a provision credit note with tax rule 1",
        {
          contactId: 1001,
          bookingCategory: "provision",
          taxRuleId: 1,
          positions: [{ name: "A", quantity: 1, unitPrice: 1, taxRate: 19 }],
        },
        "Tax rule 1 (Umsatzsteuerpflichtige Umsätze) cannot be used for provision credit notes. " +
          "Use tax rule 9; sevdesk_reference_lookup kind=tax_rules explains them.",
      ],
      [
        "a currency other than the source invoice's",
        { ...args, currency: "CHF" },
        "The source invoice 1001 is in EUR; the credit note must use the same currency.",
      ],
    ])("%s", async (_label, callArgs, message) => {
      const error = await rejection(callArgs);
      expect(error.kind).toBe("validation");
      expect(error.message).toBe(message);
    });

    it.each([
      [
        "a cancellation invoice (SR) as source",
        sourceInvoice({ invoiceType: "SR", status: "1000" }),
        "Invoice 1001 is a cancellation invoice (Stornorechnung), so a credit note " +
          "cannot be created from it.",
      ],
      [
        "a reminder (MA) as source",
        sourceInvoice({ invoiceType: "MA" }),
        "Invoice 1001 is a reminder (Mahnung); use the invoice it reminds of, so a " +
          "credit note cannot be created from it.",
      ],
      [
        "an unknown invoice type as source",
        sourceInvoice({ invoiceType: "XX" }),
        "Invoice 1001 is of type XX, so a credit note cannot be created from it.",
      ],
      [
        "a deactivated recurring invoice as source",
        sourceInvoice({ status: "50" }),
        "Invoice 1001 has status 50; credit notes are created from open, partially " +
          "paid or paid invoices only.",
      ],
      [
        "a draft source invoice",
        sourceInvoice({ status: "100" }),
        "Invoice 1001 is still a draft: change it with sevdesk_invoice_update_draft " +
          "instead; a credit note corrects finalized invoices only.",
      ],
      [
        "a source invoice of another contact",
        sourceInvoice({ contact: { id: "1002", objectName: "Contact" } }),
        "Invoice 1001 belongs to contact 1002, not to contact 1001. Use the invoice's contact.",
      ],
      [
        "a cancelled source invoice (a Storno exists)",
        {
          path: "/Invoice",
          query: { "origin[id]": 1001 },
          response: {
            body: {
              objects: [
                {
                  id: "1050",
                  objectName: "Invoice",
                  invoiceType: "SR",
                  status: "1000",
                  origin: { id: "1001", objectName: "Invoice" },
                },
              ],
            },
          },
        },
        "Invoice 1001 was cancelled (Storno) by cancellation invoice 1050; its " +
          "revenue is already reversed, so a credit note would reverse it twice. Use " +
          "sevdesk_invoice_get on the cancellation invoice to check.",
      ],
      [
        "an existing credit note for the source invoice",
        existingCreditNote,
        "A credit note for Invoice 1001 exists already: credit note 2150. Check it " +
          "with sevdesk_credit_note_get, or call again with allowDuplicate: true to create another " +
          "one (e.g. a second partial refund).",
      ],
      [
        "a source invoice that does not exist",
        notFound("/Invoice/1001"),
        "Invoice 1001 does not exist. Find it with sevdesk_invoices_list.",
      ],
    ])("%s", async (_label, route, message) => {
      const error = await rejection(args, withRoutes(routes, route));
      expect(error.message).toBe(message);
    });

    it("requires a booking category", () => {
      expect(tool.input.safeParse({ contactId: 1001, positions: args.positions }).success).toBe(
        false,
      );
      expect(tool.input.safeParse({ ...args, bookingCategory: "accounting_type" }).success).toBe(
        false,
      );
    });
  });
});
