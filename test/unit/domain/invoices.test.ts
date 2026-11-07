import { describe, expect, it } from "vitest";

import { getInvoice, listInvoices } from "../../../src/domain/invoices.js";
import { type FakeRoute, FakeSevdeskClient } from "../../helpers/fake-client.js";

const TODAY = "2026-11-07";

function detailRoutes(record: Record<string, unknown>): FakeRoute[] {
  return [
    { path: "/Invoice/77", response: { body: { objects: [{ id: "77", ...record }] } } },
    { path: "/InvoicePos", response: { body: { objects: [] } } },
    { path: "/Unity", response: { body: { objects: [] } } },
  ];
}

describe("invoice details (spec Model_InvoiceResponse fields, fake data)", () => {
  it("maps dunning data of a reminder (Mahnung)", async () => {
    const client = new FakeSevdeskClient(
      detailRoutes({
        status: "200",
        invoiceType: "MA",
        invoiceDate: "2026-11-01T00:00:00+01:00",
        timeToPay: "7",
        dunningLevel: "2",
        reminderDeadline: "2026-11-14T00:00:00+01:00",
        reminderTotal: "130.5",
        reminderCharge: "5",
        reminderDebit: "125.5",
        discount: "0",
        discountTime: "0",
        sendType: null,
        contact: null,
        contactPerson: {
          id: "7001",
          objectName: "SevUser",
          fullname: "Erika Musterfrau",
        },
      }),
    );
    const { invoice, positions, positionsComplete } = await getInvoice(
      client,
      77,
      undefined,
      TODAY,
    );
    expect(invoice).toMatchObject({
      type: { code: "MA", labelDe: "Mahnung" },
      dueDate: "2026-11-08",
      overdue: false,
      reminder: {
        dunningLevel: 2,
        deadline: "2026-11-14",
        total: { amount: "130.50", currency: "EUR" },
        charge: { amount: "5.00", currency: "EUR" },
      },
      paymentTerms: { daysToPay: 7 },
      contactPersonId: 7001,
    });
    // "0" Skonto means none; no contact, no positions.
    expect(invoice.paymentTerms).toEqual({ daysToPay: 7 });
    expect(invoice.contact).toBeUndefined();
    expect(invoice.link).toBe("https://my.sevdesk.de/fi/detail/type/MA/id/77");
    expect(positions).toEqual([]);
    expect(positionsComplete).toBe(true);
  });

  it("maps the schedule of a recurring invoice (WKR) as sevDesk sent it", async () => {
    const client = new FakeSevdeskClient(
      detailRoutes({
        status: "50",
        invoiceType: "WKR",
        accountIntervall: "P0Y1M0W",
        accountNextInvoice: "1798758000",
        showNet: "0",
        taxRule: { id: "11", objectName: "TaxRule" },
        smallSettlement: "1",
      }),
    );
    const { invoice } = await getInvoice(client, 77, undefined, TODAY);
    expect(invoice).toMatchObject({
      status: { code: 50, label: "Deactivated recurring invoice" },
      recurring: { interval: "P0Y1M0W", nextInvoice: "2027-01-01" },
      pricesEnteredAs: "gross",
      tax: { rule: { id: 11, code: "KLEINUNTERNEHMER_P19" }, smallBusiness: true },
    });
    expect(invoice.paymentTerms).toBeUndefined();
    expect(invoice.address).toBeUndefined();
  });

  it("fails on an unreadable date instead of dropping it", async () => {
    const client = new FakeSevdeskClient(
      detailRoutes({ status: "100", invoiceDate: "next tuesday" }),
    );
    await expect(getInvoice(client, 77, undefined, TODAY)).rejects.toMatchObject({
      kind: "unexpected_response",
    });
  });

  it("rejects an invalid id before calling sevDesk", async () => {
    const client = new FakeSevdeskClient([]);
    await expect(getInvoice(client, 0)).rejects.toMatchObject({ kind: "validation" });
    expect(client.calls).toHaveLength(0);
  });
});

describe("listInvoices", () => {
  it("uses the current Berlin date for overdue when none is given", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/Invoice",
        response: {
          body: {
            objects: [
              { id: "1", status: "200", invoiceDate: "2020-01-01T00:00:00+01:00", timeToPay: "1" },
              { id: "2", status: "200", invoiceDate: "2999-01-01T00:00:00+01:00", timeToPay: "1" },
            ],
          },
        },
      },
    ]);
    const result = await listInvoices(client, { limit: 25, offset: 0, overdueOnly: true });
    expect(result.items.map((item) => item.id)).toEqual([1]);
  });

  it("validates the contact id it sends", async () => {
    const client = new FakeSevdeskClient([]);
    await expect(
      listInvoices(client, { limit: 1, offset: 0, contactId: -3 }),
    ).rejects.toMatchObject({ kind: "validation" });
  });
});
