import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { invoiceGetTool as tool } from "../../../../src/tools/invoices/get.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const invoiceRoute: FakeRoute = {
  path: "/Invoice/1001",
  query: { embed: "contact" },
  response: { fixture: "invoices/invoice-1001.json" },
};
const positionsRoute: FakeRoute = {
  path: "/InvoicePos",
  query: { "invoice[id]": 1001, "invoice[objectName]": "Invoice" },
  response: { fixture: "invoices/invoice-positions-1001.json" },
};
const unitsRoute: FakeRoute = { path: "/Unity", response: { fixture: "meta/units.json" } };
const routes = [invoiceRoute, positionsRoute, unitsRoute];

async function get(id: number, withRoutes: readonly FakeRoute[] = routes) {
  const client = new FakeSevdeskClient(withRoutes);
  const result = await tool.handler(tool.input.parse({ id }), testContext(client));
  return { client, result };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sevdesk_invoice_get (community: recorded Invoice/InvoicePos shapes, fake data)", () => {
  it("is a read tool with explicit annotations", () => {
    expect(tool.tier).toBe("read");
    expect(tool.toolset).toBe("invoices");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("reads the invoice, its positions and unit names with GETs only", async () => {
    const { client } = await get(1001);
    expect(client.methods().every((method) => method === "GET")).toBe(true);
    expect(client.callsTo("/Invoice/1001")[0]?.query).toEqual({ embed: "contact" });
    expect(client.callsTo("/InvoicePos")[0]?.query).toMatchObject({
      "invoice[id]": 1001,
      "invoice[objectName]": "Invoice",
      limit: 1000,
    });
    expect(client.callsTo("/Unity")).toHaveLength(1);
  });

  it("returns the invoice with terms, tax rule, address and origin", async () => {
    const { result } = await get(1001);
    expect(tool.output.parse(result.data)).toEqual(result.data);
    const { invoice } = result.data;
    expect(invoice).toMatchObject({
      id: 1001,
      number: "RE-1001",
      status: { code: 200, label: "Open / due" },
      contact: { id: 1001, name: "Musterfirma GmbH" },
      date: "2026-10-01",
      dueDate: "2026-10-15",
      overdue: true,
      deliveryDate: "2026-10-01",
      pricesEnteredAs: "net",
      tax: {
        generation: "2.0",
        rule: { id: 1, code: "USTPFL_UMS_EINN", name: "Umsatzsteuerpflichtige Umsätze" },
        smallBusiness: false,
      },
      paymentTerms: {
        daysToPay: 14,
        cashDiscountPercent: "2",
        cashDiscountDays: 7,
        paymentMethodId: 21919,
      },
      address: { text: "Musterfirma GmbH\nMusterstraße 1\n12345 Musterstadt", countryId: 1 },
      origin: { objectName: "Order", id: 3001 },
      contactPersonId: 7001,
      internalNote: "Bestellnummer 4711",
      headText: "Vielen Dank für Ihren Auftrag.",
      createdAt: "2026-10-01",
      updatedAt: "2026-10-01",
    });
    // The recorded GET /Invoice has no propertyIsEInvoice (D-034): nothing is claimed either way.
    expect(invoice).not.toHaveProperty("eInvoice");
    expect(invoice.reminder).toBeUndefined();
    expect(invoice.recurring).toBeUndefined();
  });

  it("returns positions sorted, with unit names, prices, discounts and sanitized text", async () => {
    const { result } = await get(1001);
    expect(result.data.positionsComplete).toBe(true);
    expect(result.data.positions.map((position) => position.id)).toEqual([5001, 5002, 5003]);
    expect(result.data.positions[0]).toEqual({
      id: 5001,
      number: 1,
      name: "Testartikel",
      text: "Beschreibung des Testartikels",
      partId: 6001,
      quantity: "2",
      unit: { id: 1, name: "Stk" },
      unitPriceNet: { amount: "42.01", currency: "EUR" },
      unitPriceGross: { amount: "49.9919", currency: "EUR" },
      taxRate: "19",
      totals: {
        net: { amount: "84.02", currency: "EUR" },
        tax: { amount: "15.96", currency: "EUR" },
        gross: { amount: "99.98", currency: "EUR" },
      },
    });
    expect(result.data.positions[1]).toMatchObject({ unit: { id: 9, name: "Std" } });
    const third = result.data.positions[2];
    // Invisible and bidi characters are stripped; unknown unit ids keep the id only.
    expect(third).toMatchObject({
      name: "Versandpauschale",
      unit: { id: 99 },
      discount: { value: "5", isPercentage: false },
    });
    expect(third?.partId).toBeUndefined();
    expect(result.summary).toBe(
      "Invoice 1001 (Normal invoice, status Open / due) with 3 positions.",
    );
  });

  it("keeps unit ids when the unit list cannot be read", async () => {
    const { result } = await get(1001, [
      invoiceRoute,
      positionsRoute,
      { ...unitsRoute, response: { error: new SevdeskError({ kind: "server", message: "x" }) } },
    ]);
    expect(result.data.positions[0]?.unit).toEqual({ id: 1 });
  });

  it("filters positions of other invoices when sevDesk ignores the filter", async () => {
    const { result } = await get(1001, [
      invoiceRoute,
      { ...positionsRoute, response: { fixture: "invoices/invoice-positions-unfiltered.json" } },
      unitsRoute,
    ]);
    expect(result.data.positions.map((position) => position.id)).toEqual([5001, 5002, 5003]);
    expect(result.data.positionsComplete).toBe(true);
  });

  it("maps an empty GET-by-id array to not_found", async () => {
    const client = new FakeSevdeskClient([
      { ...invoiceRoute, path: "/Invoice/42", response: { body: { objects: [] } } },
      {
        ...positionsRoute,
        query: { "invoice[id]": 42 },
        response: { body: { objects: [] } },
      },
      unitsRoute,
    ]);
    await expect(
      tool.handler(tool.input.parse({ id: 42 }), testContext(client)),
    ).rejects.toMatchObject({ kind: "not_found", message: "sevDesk found no invoice 42." });
  });

  it("rejects invalid ids before calling sevDesk", () => {
    expect(() => tool.input.parse({ id: 0 })).toThrow();
    expect(() => tool.input.parse({ id: 1.5 })).toThrow();
    expect(() => tool.input.parse({ id: "1001" })).toThrow();
    expect(() => tool.input.parse({ id: 1, embed: "x" })).toThrow();
  });
});
