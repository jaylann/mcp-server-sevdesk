import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { invoiceUpdateDraftTool as tool } from "../../../../src/tools/invoices/draft-update.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  invoiceUpdateRoutes as routes,
  notFound,
  saveInvoiceRoute,
  TIMESTAMPS,
  withRoutes,
} from "./routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

/** The stored draft 2102 with some fields replaced. */
function storedDraft(fields: Record<string, unknown>): FakeRoute {
  const stored = loadFixture("drafts/invoice-2102-draft.json").body as {
    objects: Record<string, unknown>[];
  };
  return {
    path: "/Invoice/2102",
    response: { body: { objects: [{ ...stored.objects[0], ...fields }] } },
  };
}

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

/** Every stored field carried over (fixture invoice-2102-draft.json). */
const carriedInvoice = {
  id: 2102,
  objectName: "Invoice",
  mapAll: true,
  invoiceType: "RE",
  status: 100,
  contact: { id: 1001, objectName: "Contact" },
  contactPerson: { id: 7001, objectName: "SevUser" },
  invoiceDate: "02.11.2026",
  deliveryDate: TIMESTAMPS["2026-11-02"],
  header: "Rechnung",
  headText: "Vielen Dank für Ihren Auftrag.",
  footText: "Zahlbar innerhalb von 14 Tagen.",
  timeToPay: 14,
  discount: 2,
  discountTime: 7,
  currency: "EUR",
  showNet: true,
  taxRule: { id: 1, objectName: "TaxRule" },
  taxRate: 0,
  taxText: "Umsatzsteuer 19%",
  smallSettlement: false,
  address: "Musterfirma GmbH\nMusterstraße 1\n12345 Musterstadt",
  addressCountry: { id: 1, objectName: "StaticCountry" },
  customerInternalNote: "Bestellnummer 4711",
  paymentMethod: { id: 21919, objectName: "PaymentMethod" },
};

describe("sevdesk_invoice_update_draft (community shapes, fake data)", () => {
  it("is a write-tier update tool with explicit annotations", () => {
    expect(tool.tier).toBe("write");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("changes one field and carries every stored field over, positions untouched", async () => {
    const { client, plan } = await prepare({ id: 2102, header: "Rechnung Projekt X" });
    expect(client.writes()).toEqual([]);
    expect(plan.state.body).toEqual({
      invoice: { ...carriedInvoice, header: "Rechnung Projekt X" },
      invoicePosSave: null,
      invoicePosDelete: null,
    });
    expect(plan.preview.action).toBe(
      "Update draft invoice 2102 for Musterfirma GmbH (contact 1001): change title.",
    );
    expect(plan.preview.facts).toEqual([
      { label: "Invoice", value: "2102 (no number yet, draft)" },
      { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
      { label: "Title", value: "Rechnung → Rechnung Projekt X" },
      { label: "Total (unchanged)", value: "gross 116.60 EUR" },
    ]);
    // No users, countries or units are read when nothing needs them.
    expect(client.callsTo("/SevUser")).toEqual([]);
    expect(client.callsTo("/StaticCountry")).toEqual([]);
  });

  it("replaces all positions in one request (deletes the stored ones)", async () => {
    const { plan } = await prepare({
      id: 2102,
      positions: [{ name: "Wartung", quantity: 2, unitPrice: 80, taxRate: 19 }],
    });
    expect(plan.state.body.invoicePosSave).toEqual([
      {
        objectName: "InvoicePos",
        mapAll: true,
        quantity: 2,
        price: "80.00",
        name: "Wartung",
        unity: { id: 1, objectName: "Unity" },
        taxRate: 19,
        positionNumber: 0,
      },
    ]);
    expect(plan.state.body.invoicePosDelete).toEqual([
      { id: 5201, objectName: "InvoicePos" },
      { id: 5202, objectName: "InvoicePos" },
    ]);
    expect(plan.state.expected).toEqual({ net: "160.00", tax: "30.40", gross: "190.40" });
    expect(plan.preview.facts).toContainEqual({
      label: "Positions",
      value: "replace 2 positions with 1 position",
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Total (expected)",
      value: "net 160.00 EUR, tax 30.40 EUR, gross 190.40 EUR",
    });
  });

  it("saves once, reads the invoice back and reports it as affected", async () => {
    const client = new FakeSevdeskClient(routes);
    const { output } = await executeWrite(tool, { id: 2102, timeToPay: 30 }, client);
    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/Invoice/Factory/saveInvoice",
        tier: "write",
      }),
    ]);
    expect(client.writes()[0]?.body).toMatchObject({ invoice: { id: 2102, timeToPay: 30 } });
    expect(output.affected).toEqual([{ objectName: "Invoice", id: "2102" }]);
    expect(output.data.invoice).toMatchObject({ id: 2102, status: { code: 100 } });
    expect(output.summary).toMatch(
      /^Updated draft invoice 2102 \(2 positions, gross 116.60 EUR\)\./,
    );
  });

  it("takes the new contact's invoice address and writes it both ways", async () => {
    const otherContact: FakeRoute[] = [
      {
        path: "/Contact/1002",
        response: { fixture: "contacts/contact-1002.json" },
      },
      {
        path: "/ContactAddress",
        query: { "contact[id]": 1002 },
        response: {
          body: {
            objects: [
              {
                id: "3101",
                objectName: "ContactAddress",
                contact: { id: "1002", objectName: "Contact" },
                street: "Hauptstraße 9",
                zip: "54321",
                city: "Beispielstadt",
                country: { id: "1", objectName: "StaticCountry" },
                category: { id: "48", objectName: "Category" },
                name: null,
              },
            ],
          },
        },
      },
      {
        path: "/CommunicationWay",
        query: { "contact[id]": 1002 },
        response: { body: { objects: [] } },
      },
    ];
    const { plan } = await prepare(
      { id: 2102, contactId: 1002 },
      withRoutes(routes, ...otherContact),
    );
    // The address has no name lines, so the contact's name (a person) is printed.
    expect(plan.state.body.invoice).toMatchObject({
      contact: { id: 1002, objectName: "Contact" },
      address: "Dr. Max Mustermann\nHauptstraße 9\n54321 Beispielstadt",
      addressName: "Dr. Max Mustermann",
      addressStreet: "Hauptstraße 9",
      addressZip: "54321",
      addressCity: "Beispielstadt",
      addressCountry: { id: 1, objectName: "StaticCountry" },
    });
    expect(plan.preview.action).toBe(
      "Update draft invoice 2102 for Dr. Max Mustermann (contact 1002): change contact, address.",
    );
    expect(plan.preview.facts).toContainEqual({
      label: "Address",
      value:
        "Musterfirma GmbH, Musterstraße 1, 12345 Musterstadt, Deutschland → Dr. Max Mustermann, " +
        "Hauptstraße 9, 54321 Beispielstadt, Deutschland",
    });
  });

  it("validates a new tax rule against the stored rates", async () => {
    const error = await rejection({ id: 2102, taxRule: 11 });
    expect(error.message).toBe(
      "Position 1 has a tax rate of 19 %, which tax rule 11 (Steuer nicht erhoben nach §19UStG) " +
        "does not allow. Tax rule 11 allows 0 %. To charge VAT on domestic sales use tax rule 1.",
    );
  });

  it("writes a new tax rule with its default text", async () => {
    const zeroRated = [
      storedDraft({}),
      {
        path: "/InvoicePos",
        query: { "invoice[id]": 2102 },
        response: {
          body: {
            objects: [
              {
                id: "5201",
                objectName: "InvoicePos",
                invoice: { id: "2102", objectName: "Invoice" },
                quantity: "1",
                price: "10",
                taxRate: "0",
                positionNumber: "0",
              },
            ],
          },
        },
      },
    ];
    const { plan } = await prepare({ id: 2102, taxRule: 4 }, withRoutes(routes, ...zeroRated));
    expect(plan.state.body.invoice).toMatchObject({
      taxRule: { id: 4, objectName: "TaxRule" },
      taxText: "Steuerfreie Umsätze §4 UStG",
      smallSettlement: false,
    });
  });

  it("keeps a stored legacy tax type with its tax set", async () => {
    const legacy = storedDraft({
      taxRule: null,
      taxType: "custom",
      taxSet: { id: "55", objectName: "TaxSet" },
    });
    const { plan } = await prepare({ id: 2102, footText: "Neu" }, withRoutes(routes, legacy));
    expect(plan.state.body.invoice).toMatchObject({
      taxType: "custom",
      taxSet: { id: 55, objectName: "TaxSet" },
    });
    expect(plan.state.body.invoice).not.toHaveProperty("taxRule");
  });

  describe("address changes merge over the stored address", () => {
    /** A draft saved through the API: structured address, no free text, country Afghanistan. */
    const structured = storedDraft({
      address: null,
      addressName: "Musterfirma GmbH",
      addressStreet: "Musterstraße 1",
      addressZip: "12345",
      addressCity: "Musterstadt",
      addressCountry: { id: "4", objectName: "StaticCountry" },
    });

    it("changes one part and sends every part, keeping name, city and country", async () => {
      const { plan } = await prepare(
        { id: 2102, addressZip: "54321" },
        withRoutes(routes, structured),
      );
      expect(plan.state.body.invoice).toMatchObject({
        address: "Musterfirma GmbH\nMusterstraße 1\n54321 Musterstadt\nAfghanistan",
        addressName: "Musterfirma GmbH",
        addressStreet: "Musterstraße 1",
        addressZip: "54321",
        addressCity: "Musterstadt",
        addressCountry: { id: 4, objectName: "StaticCountry" },
      });
      expect(plan.preview.facts).toContainEqual({
        label: "Address",
        value:
          "Musterfirma GmbH, Musterstraße 1, 12345 Musterstadt, Afghanistan → Musterfirma GmbH, " +
          "Musterstraße 1, 54321 Musterstadt, Afghanistan",
      });
    });

    it("changes only the country and shows it", async () => {
      const { plan } = await prepare(
        { id: 2102, addressCountry: "DE" },
        withRoutes(routes, structured),
      );
      expect(plan.state.body.invoice).toMatchObject({
        addressZip: "12345",
        addressCountry: { id: 1, objectName: "StaticCountry" },
      });
      expect(plan.preview.facts).toContainEqual({
        label: "Address",
        value:
          "Musterfirma GmbH, Musterstraße 1, 12345 Musterstadt, Afghanistan → Musterfirma GmbH, " +
          "Musterstraße 1, 12345 Musterstadt, Deutschland",
      });
    });

    it("sends empty parts as null", async () => {
      const noStreet = storedDraft({
        address: null,
        addressName: "Musterfirma GmbH",
        addressStreet: null,
        addressZip: null,
        addressCity: "Musterstadt",
      });
      const { plan } = await prepare(
        { id: 2102, addressName: "Musterfirma AG" },
        withRoutes(routes, noStreet),
      );
      expect(plan.state.body.invoice).toMatchObject({
        addressName: "Musterfirma AG",
        addressStreet: null,
        addressZip: null,
        addressCity: "Musterstadt",
      });
    });

    it("replaces a free-text address only as a whole, keeping its country", async () => {
      const error = await rejection({ id: 2102, addressZip: "54321" });
      expect(error.message).toBe(
        "The stored address of this draft is free text, so single parts of it cannot be " +
          "changed. Give addressName, addressStreet, addressZip and addressCity together " +
          "(addressCountry keeps the stored country unless given).",
      );
      const { plan } = await prepare({
        id: 2102,
        addressName: "Musterfirma GmbH",
        addressStreet: "Neue Str. 3",
        addressZip: "12345",
        addressCity: "Musterstadt",
      });
      expect(plan.state.body.invoice).toMatchObject({
        address: "Musterfirma GmbH\nNeue Str. 3\n12345 Musterstadt",
        addressCountry: { id: 1, objectName: "StaticCountry" },
      });
    });

    it("takes the contact's address for a draft without one", async () => {
      const none = storedDraft({ address: null, addressCountry: null });
      const { plan } = await prepare(
        { id: 2102, addressStreet: "Neue Str. 3" },
        withRoutes(routes, none),
      );
      expect(plan.state.body.invoice).toMatchObject({
        addressName: "Musterfirma GmbH, Buchhaltung",
        addressStreet: "Neue Str. 3",
        addressZip: "12345",
        addressCity: "Musterstadt",
      });
      expect(plan.preview.facts).toContainEqual({
        label: "Address",
        value:
          "(none) → Musterfirma GmbH, Buchhaltung, Neue Str. 3, 12345 Musterstadt, Deutschland",
      });
    });
  });

  it("shows a foreign-currency total in its own currency", async () => {
    const usd = storedDraft({ currency: "USD", sumGrossForeignCurrency: "130.5" });
    const { plan } = await prepare({ id: 2102, header: "X" }, withRoutes(routes, usd));
    expect(plan.preview.facts).toContainEqual({
      label: "Total (unchanged)",
      value: "gross 130.50 USD (116.60 EUR booked)",
    });
  });

  it("keeps the stored number unchanged (B4)", async () => {
    const numbered = storedDraft({ invoiceNumber: "RE-1042" });
    const { plan } = await prepare({ id: 2102, timeToPay: 7 }, withRoutes(routes, numbered));
    expect(plan.state.body.invoice.invoiceNumber).toBe("RE-1042");
    expect(plan.preview.facts[0]).toEqual({
      label: "Invoice",
      value: "2102 (number RE-1042, draft)",
    });
  });

  describe("refuses before sending anything", () => {
    it.each([
      [
        "nothing to change",
        { id: 2102 },
        "Nothing to change: give at least one field of the invoice besides id.",
      ],
      [
        "a new price mode without positions",
        { id: 2102, priceMode: "gross" },
        "Changing priceMode from net to gross would make sevDesk read every stored price as " +
          "gross. Pass the positions again with prices in the new mode.",
      ],
      [
        "a date before the stored delivery date",
        { id: 2102, date: "2026-11-01" },
        "The delivery date 2026-11-02 is after the invoice date 2026-11-01, which sevDesk does " +
          "not allow for a regular invoice. Use a delivery date on or before the invoice date, or " +
          "create an advance invoice (Abschlagsrechnung) in sevDesk.",
      ],
    ])("%s", async (_label, args, message) => {
      const error = await rejection(args);
      expect(error.kind).toBe("validation");
      expect(error.message).toBe(message);
    });

    it.each([
      [
        "an open invoice",
        { status: "200" },
        'Invoice 2102 is not a draft (status: Open / due); only drafts can be changed. Reset it to a draft first with sevdesk_invoice_reset (to: "draft") or cancel it with sevdesk_invoice_cancel.',
      ],
      [
        "an enshrined invoice",
        { enshrined: "2026-11-05T10:00:00+01:00" },
        "Invoice 2102 is enshrined (festgeschrieben) and can no longer be changed.",
      ],
      [
        "a reminder",
        { invoiceType: "MA" },
        "Invoice 2102 is a reminder invoice (MA); this tool only changes regular invoices (RE). Edit it in sevDesk.",
      ],
      [
        "an unknown invoice type",
        { invoiceType: "XX" },
        "Invoice 2102 is not a regular invoice; this tool only changes regular invoices (RE). Edit it in sevDesk.",
      ],
      [
        "a stored tax setting it cannot check against new positions",
        { taxRule: null, taxType: "custom" },
        "The stored tax setting of this draft is not a tax rule this server knows (e.g. a custom tax set), so the positions cannot be checked against it. Pass taxRule as well.",
      ],
      [
        "a draft without a contact",
        { contact: null },
        "This draft has no contact. Pass contactId (find it with sevdesk_contacts_search).",
      ],
    ])("%s", async (_label, fields, message) => {
      const args = _label.startsWith("a stored tax setting")
        ? { id: 2102, positions: [{ name: "A", quantity: 1, unitPrice: 1, taxRate: 19 }] }
        : { id: 2102, header: "Neu" };
      const error = await rejection(args, withRoutes(routes, storedDraft(fields)));
      expect(error.message).toBe(message);
    });

    it("an e-invoice with a One-Stop-Shop rule", async () => {
      const eInvoice = storedDraft({ propertyIsEInvoice: "1" });
      const error = await rejection({ id: 2102, taxRule: 18 }, withRoutes(routes, eInvoice));
      expect(error.message).toBe(
        "Tax rule 18 (One-Stop-Shop - Warenverkauf in die EU) is not supported for e-invoices, " +
          "and this invoice is one. Choose another tax rule.",
      );
    });

    it("an invoice that does not exist", async () => {
      const error = await rejection(
        { id: 2102, header: "Neu" },
        withRoutes(routes, notFound("/Invoice/2102")),
      );
      expect(error.message).toBe(
        "Invoice 2102 does not exist in sevDesk. Find the right id with sevdesk_invoices_list.",
      );
    });

    it("an invoice whose positions cannot all be read", async () => {
      const page = {
        path: "/InvoicePos",
        query: { "invoice[id]": 2102 },
        // A recorded single page (answered for every offset) with rows of another invoice: the
        // reader pages to its cap and reports the rows as incomplete.
        response: {
          body: {
            objects: [
              {
                id: "5201",
                objectName: "InvoicePos",
                invoice: { id: "9999", objectName: "Invoice" },
              },
            ],
            total: "20000",
          },
        },
      };
      const client = new FakeSevdeskClient(withRoutes(routes, page));
      const error = await prepareWrite(tool, { id: 2102, header: "Neu" }, client).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(SevdeskError);
      expect((error as SevdeskError).message).toBe(
        "The invoice 2102 has more positions than this server reads at once, so it cannot be " +
          "updated safely here. Edit it in sevDesk.",
      );
    });
  });

  it("fails loudly when sevDesk saved a different invoice", async () => {
    const client = new FakeSevdeskClient(withRoutes(routes, saveInvoiceRoute));
    const error = await executeWrite(tool, { id: 2102, header: "Neu" }, client).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).message).toBe(
      "sevDesk saved invoice 2101 instead of updating invoice 2102. Check both drafts in sevDesk " +
        "and delete the extra one there before repeating the call.",
    );
    expect((error as SevdeskError).completedWrites).toEqual([
      { objectName: "Invoice", id: "2101" },
    ]);
  });
});
