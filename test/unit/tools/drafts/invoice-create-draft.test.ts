import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { readOnlyClient } from "../../../../src/sevdesk/scoped-client.js";
import { invoiceCreateDraftTool as tool } from "../../../../src/tools/invoices/draft-create.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  invoiceCreateArgs as args,
  invoiceCreateRoutes as routes,
  notFound,
  TIMESTAMPS,
  twoUsersRoute,
  version1Route,
  withRoutes,
} from "./routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

async function prepare(callArgs: unknown, withRouteTable: readonly FakeRoute[] = routes) {
  const client = new FakeSevdeskClient(withRouteTable);
  const plan = await prepareWrite(tool, callArgs, client);
  return { client, plan };
}

async function rejection(callArgs: unknown, withRouteTable: readonly FakeRoute[] = routes) {
  const client = new FakeSevdeskClient(withRouteTable);
  const error = await prepareWrite(tool, callArgs, client).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect(client.writes()).toEqual([]);
  return error as SevdeskError;
}

/** The body in sevdesk-rs's request shape (from its source; net prices), with our fake data. */
const expectedBody = {
  invoice: {
    objectName: "Invoice",
    mapAll: true,
    invoiceType: "RE",
    status: 100,
    contact: { id: 1001, objectName: "Contact" },
    contactPerson: { id: 2001, objectName: "SevUser" },
    invoiceDate: "07.11.2026",
    deliveryDate: TIMESTAMPS["2026-11-07"],
    header: "Rechnung",
    discount: 0,
    currency: "EUR",
    showNet: true,
    taxRule: { id: 1, objectName: "TaxRule" },
    taxRate: 0,
    taxText: "Umsatzsteuerpflichtige Umsätze",
    smallSettlement: false,
    addressName: "Musterfirma GmbH, Buchhaltung",
    addressStreet: "Musterstraße 1",
    addressZip: "12345",
    addressCity: "Musterstadt",
    addressCountry: { id: 1, objectName: "StaticCountry" },
  },
  invoicePosSave: [
    {
      objectName: "InvoicePos",
      mapAll: true,
      quantity: 3,
      price: "10.00",
      name: "Beratung",
      unity: { id: 1, objectName: "Unity" },
      taxRate: 19,
      positionNumber: 0,
    },
    {
      objectName: "InvoicePos",
      mapAll: true,
      quantity: 1,
      price: "25.00",
      name: "Paket",
      unity: { id: 1, objectName: "Unity" },
      taxRate: 19,
      positionNumber: 1,
      text: "Zweite Zeile\nund eine dritte",
    },
  ],
  invoicePosDelete: null,
};

describe("sevdesk_invoice_create_draft (community: sevdesk-rs request shape + recorded response, fake data)", () => {
  it("is a write-tier create tool with explicit annotations", () => {
    expect(tool.tier).toBe("write");
    expect(tool.toolset).toBe("invoices");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("prepares sevdesk-rs's body with defaults and reads only", async () => {
    const { client, plan } = await prepare(args);
    expect(client.writes()).toEqual([]);
    expect(plan.state.body).toEqual(expectedBody);
    expect(JSON.parse(JSON.stringify(plan.state.body))).toEqual(expectedBody);
    expect(plan.state.expected).toEqual({ net: "55.00", tax: "10.45", gross: "65.45" });
  });

  it("previews customer, address, dates, tax, positions and totals", async () => {
    const { plan } = await prepare(args);
    expect(plan.preview.action).toBe(
      "Create a draft invoice (Rechnungsentwurf) for Musterfirma GmbH (contact 1001) with 2 " +
        "positions, gross 65.45 EUR.",
    );
    expect(plan.preview.irreversible).toBe(false);
    expect(plan.preview.warnings).toEqual([]);
    expect(plan.preview.facts).toEqual([
      { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
      {
        label: "Address",
        value: "Musterfirma GmbH, Buchhaltung, Musterstraße 1, 12345 Musterstadt, Deutschland",
      },
      { label: "Invoice date", value: "2026-11-07" },
      { label: "Delivery date", value: "2026-11-07" },
      { label: "Contact person", value: "Erika Musterfrau (user 2001)" },
      { label: "Title", value: "Rechnung" },
      { label: "Prices entered as", value: "net" },
      { label: "Tax", value: "tax rule 1 Umsatzsteuerpflichtige Umsätze" },
      { label: "Tax text", value: "Umsatzsteuerpflichtige Umsätze" },
      { label: "Position 1", value: "Beratung: 3 × 10.00 EUR net, 19 % VAT → net 30.00 EUR" },
      {
        label: "Position 2",
        value: "Paket: 1 × 25.00 EUR net, 19 % VAT → net 25.00 EUR",
      },
      { label: "Total (expected)", value: "net 55.00 EUR, tax 10.45 EUR, gross 65.45 EUR" },
    ]);
  });

  it("is deterministic for the same state (the framework prepares twice)", async () => {
    const first = await prepare(args);
    const second = await prepare(args);
    expect(second.plan).toEqual(first.plan);
  });

  it("saves once with the write tier, reads the invoice back and reports it as affected", async () => {
    const client = new FakeSevdeskClient(routes);
    const { output } = await executeWrite(tool, args, client);
    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/Invoice/Factory/saveInvoice",
        tier: "write",
        body: expectedBody,
      }),
    ]);
    expect(output.affected).toEqual([{ objectName: "Invoice", id: "2101" }]);
    expect(output.data.invoice).toMatchObject({
      id: 2101,
      status: { code: 100, label: "Draft" },
      contact: { id: 1001, name: "Musterfirma GmbH" },
      date: "2026-11-07",
      totals: {
        net: { amount: "55.00", currency: "EUR" },
        gross: { amount: "65.45", currency: "EUR" },
      },
      priceMode: "net",
      contactPersonId: 2001,
    });
    expect(output.data.positions.map((position) => position.name)).toEqual(["Beratung", "Paket"]);
    expect(output.data.notes).toEqual([
      "The invoice has no number yet: sevDesk assigns it from its number range (Nummernkreis), " +
        "at the latest when the invoice is finalized with sevdesk_invoice_finalize.",
    ]);
    expect(output.summary).toBe(
      "Created draft invoice 2101 (2 positions, gross 65.45 EUR). See notes.",
    );
  });

  it("sends gross prices with showNet false and computes the net from the gross", async () => {
    const { plan } = await prepare({
      contactId: 1001,
      priceMode: "gross",
      positions: [
        { name: "Ticket", quantity: 1, unitPrice: "11.90", taxRate: 19 },
        { name: "Buch", quantity: 2, unitPrice: "5.00", taxRate: 7 },
      ],
    });
    expect(plan.state.body.invoice.showNet).toBe(false);
    expect(plan.state.body.invoicePosSave?.map((position) => position.price)).toEqual([
      "11.90",
      "5.00",
    ]);
    expect(plan.state.expected).toEqual({ net: "19.35", tax: "2.55", gross: "21.90" });
  });

  it("takes the given dates, payment term, texts, tax rule and address", async () => {
    const { plan } = await prepare({
      ...args,
      date: "2026-11-30",
      deliveryDate: "2026-11-02",
      deliveryDateUntil: "2026-11-07",
      timeToPay: 30,
      header: "Rechnung Projekt X",
      headText: "<p>Hallo</p>",
      footText: "Danke.",
      taxText: "zzgl. Umsatzsteuer 19 %",
      addressName: "Max Mustermann",
      addressStreet: "Bahnhofstr. 2",
      addressZip: "1010",
      addressCity: "Wien",
      addressCountry: "af",
    });
    expect(plan.state.body.invoice).toMatchObject({
      invoiceDate: "30.11.2026",
      deliveryDate: TIMESTAMPS["2026-11-02"],
      deliveryDateUntil: TIMESTAMPS["2026-11-07"],
      timeToPay: 30,
      header: "Rechnung Projekt X",
      headText: "<p>Hallo</p>",
      footText: "Danke.",
      taxText: "zzgl. Umsatzsteuer 19 %",
      addressName: "Max Mustermann",
      addressStreet: "Bahnhofstr. 2",
      addressZip: "1010",
      addressCity: "Wien",
      addressCountry: { id: 4, objectName: "StaticCountry" },
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Address",
      value: "Max Mustermann, Bahnhofstr. 2, 1010 Wien, Afghanistan",
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Delivery date",
      value: "2026-11-02 – 2026-11-07",
    });
    expect(plan.preview.facts).toContainEqual({ label: "Payment term", value: "30 days" });
  });

  it("writes the legacy taxType on a bookkeeping 1.0 account", async () => {
    const { plan } = await prepare(args, withRoutes(routes, version1Route));
    expect(plan.state.body.invoice).toMatchObject({ taxType: "default", taxRate: 0 });
    expect(plan.state.body.invoice).not.toHaveProperty("taxRule");
    expect(plan.preview.facts).toContainEqual({
      label: "Tax",
      value: "tax type default (from tax rule 1 Umsatzsteuerpflichtige Umsätze), bookkeeping 1.0",
    });
  });

  // Review 2026-11, round 3: the write flow prepares with a new read-only client wrapper on
  // every call, and the version cache was keyed by that wrapper.
  it("asks for the bookkeeping version once across preparations of one account", async () => {
    const client = new FakeSevdeskClient(routes);
    const ctx = testContext(client);
    const parsed = tool.input.parse(args);

    for (let call = 0; call < 3; call += 1) {
      await tool.prepare(parsed, { ...ctx, client: readOnlyClient(client, "preparing a write") });
    }

    expect(client.callsTo("/Tools/bookkeepingSystemVersion")).toHaveLength(1);
  });

  it("warns about a possible duplicate without blocking", async () => {
    const duplicate: FakeRoute = {
      path: "/Invoice",
      query: { "contact[id]": 1001 },
      response: {
        body: {
          objects: [
            {
              id: "1999",
              objectName: "Invoice",
              invoiceType: "RE",
              status: "100",
              currency: "EUR",
              sumGross: "65.45",
              invoiceDate: "2026-11-07T00:00:00+01:00",
            },
            {
              id: "1998",
              objectName: "Invoice",
              invoiceType: "RE",
              status: "100",
              currency: "EUR",
              sumGross: "65.46",
              invoiceDate: "2026-11-07T00:00:00+01:00",
            },
          ],
        },
      },
    };
    const { plan } = await prepare(args, withRoutes(routes, duplicate));
    expect(plan.preview.warnings).toEqual([
      "Possible duplicate: invoice 1999 for the same contact, date (2026-11-07) and gross total " +
        "(65.45 EUR) already exists. Check it before creating another one.",
    ]);
  });

  it("adds a note when sevDesk's total differs from the preview (B8 safety net)", async () => {
    const client = new FakeSevdeskClient(routes);
    const { output } = await executeWrite(
      tool,
      { ...args, positions: [{ name: "Beratung", quantity: 3, unitPrice: 10, taxRate: 19 }] },
      client,
    );
    expect(output.data.notes).toContain(
      "sevDesk computed a gross total of 65.45 EUR; the preview expected 35.70 EUR. Check the " +
        "positions and the price mode (net/gross) before finalizing.",
    );
  });

  describe("refuses before sending anything", () => {
    it.each([
      [
        "a rate the tax rule does not allow",
        { positions: [{ name: "A", quantity: 1, unitPrice: 1, taxRate: 16 }] },
        "Position 1 has a tax rate of 16 %, which tax rule 1 (Umsatzsteuerpflichtige Umsätze) " +
          "does not allow. Tax rule 1 allows 0, 7, 19 %.",
      ],
      [
        "a missing rate when the rule allows several",
        { positions: [{ name: "A", quantity: 1, unitPrice: 1 }] },
        "Position 1 has no taxRate. Tax rule 1 allows 0, 7, 19 %. Say which one applies.",
      ],
      [
        "an expense tax rule",
        { taxRuleId: 9 },
        "Tax rule 9 (Vorsteuerabziehbare Aufwendungen) cannot be used for invoices (it is a rule " +
          "for expenses). Use tax rule 1, 2, 3, 4, 5, 11, 17, 18, 19, 20, 21; " +
          "sevdesk_reference_lookup kind=tax_rules explains them.",
      ],
      [
        "an unknown tax rule",
        { taxRuleId: 99 },
        "Tax rule 99 does not exist. Invoices take tax rule 1, 2, 3, 4, 5, 11, 17, 18, 19, 20, " +
          "21; sevdesk_reference_lookup kind=tax_rules explains them.",
      ],
      [
        "a delivery date after the invoice date",
        { deliveryDate: "2026-11-30" },
        "The delivery date 2026-11-30 is after the invoice date 2026-11-07, which sevDesk does " +
          "not allow for a regular invoice. Use a delivery date on or before the invoice date, or " +
          "create an advance invoice (Abschlagsrechnung) in sevDesk.",
      ],
      [
        "a delivery period that ends before it starts",
        { deliveryDate: "2026-11-07", deliveryDateUntil: "2026-11-02" },
        "deliveryDateUntil 2026-11-02 is before the delivery date 2026-11-07.",
      ],
      [
        "an unknown currency",
        { currency: "XYZ" },
        "XYZ is not an ISO 4217 currency code; use e.g. EUR, CHF or USD.",
      ],
      [
        "a discount above 100 %",
        {
          positions: [{ name: "A", quantity: 1, unitPrice: 1, taxRate: 19, discountPercent: 101 }],
        },
        "Position 1 has a discount above 100 %; give discountPercent from 0.01 to 100.",
      ],
      [
        "an unknown country code",
        { addressCity: "Bern", addressCountry: "CH" },
        "sevDesk does not know the country code CH. sevdesk_reference_lookup kind=countries " +
          "lists the countries and their codes.",
      ],
      [
        "an unknown user as contact person",
        { contactPersonId: 2999 },
        "User 2999 is not a user of this sevDesk account. sevdesk_reference_lookup kind=users " +
          "lists the users and their ids.",
      ],
      [
        "an unknown unit",
        { positions: [{ name: "A", quantity: 1, unitPrice: 1, taxRate: 19, unitId: 77 }] },
        "Position 1 uses unit 77, which this sevDesk account does not have. " +
          "sevdesk_reference_lookup kind=units lists the units and their ids.",
      ],
    ])("%s", async (_label, change, message) => {
      const error = await rejection({ ...args, ...change });
      expect(error.kind).toBe("validation");
      expect(error.message).toBe(message);
    });

    it("a contact that does not exist", async () => {
      const error = await rejection(args, withRoutes(routes, notFound("/Contact/1001")));
      expect(error.message).toBe(
        "Contact 1001 does not exist in sevDesk. Find the customer's id with " +
          "sevdesk_contacts_search (or create the contact first).",
      );
    });

    it("a contact without any address", async () => {
      const noAddress: FakeRoute = { path: "/ContactAddress", response: { body: { objects: [] } } };
      const error = await rejection(args, withRoutes(routes, noAddress));
      expect(error.message).toBe(
        "Contact 1001 has no address. Give addressName, addressStreet, addressZip, addressCity " +
          "and addressCountry, or add an address to the contact first.",
      );
    });

    it("several users and no contactPersonId (B3)", async () => {
      const error = await rejection(args, withRoutes(routes, twoUsersRoute));
      expect(error.message).toBe(
        "This sevDesk account has 2 users (ids 2001, 2002). Say which one is the contact person " +
          "(Ansprechpartner) of the document with contactPersonId; sevdesk_reference_lookup " +
          "kind=users shows their names.",
      );
    });

    it("rejects unknown arguments and a quantity of 0 in the input schema", () => {
      expect(tool.input.safeParse({ ...args, invoiceNumber: "RE-1" }).success).toBe(false);
      expect(
        tool.input.safeParse({ ...args, positions: [{ name: "A", quantity: 0, unitPrice: 1 }] })
          .success,
      ).toBe(false);
      expect(tool.input.safeParse({ ...args, positions: [] }).success).toBe(false);
    });
  });

  describe("after the save", () => {
    it("names the saved invoice when the read-back fails", async () => {
      const failingReadBack = notFound("/Invoice/2101");
      const client = new FakeSevdeskClient(withRoutes(routes, failingReadBack));
      const error = await executeWrite(tool, args, client).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(SevdeskError);
      expect((error as SevdeskError).completedWrites).toEqual([
        { objectName: "Invoice", id: "2101" },
      ]);
      expect(client.writes()).toHaveLength(1);
    });

    it("explains an answer without an id instead of guessing", async () => {
      const noId: FakeRoute = {
        method: "POST",
        path: "/Invoice/Factory/saveInvoice",
        response: { body: { objects: { invoice: null } } },
      };
      const client = new FakeSevdeskClient(withRoutes(routes, noId));
      await expect(executeWrite(tool, args, client)).rejects.toMatchObject({
        kind: "unexpected_response",
        message:
          "sevDesk accepted the invoice but its answer did not contain the invoice's id, so it " +
          "could not be read back. Look for the new draft in sevDesk before repeating the call.",
      });
    });
  });
});
