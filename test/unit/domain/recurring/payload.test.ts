/**
 * The body of a new recurring invoice template (spec/deviations.md D-111, D-003): always
 * `invoiceType: "WKR"`, the schedule only as `accountIntervall` + `accountStartDate` (+
 * `accountEndDate`), never `accountNextInvoice` (ignored when sent alone) nor the `recurring…`
 * fields of the voucher model (dropped silently), no id and no number.
 */
import { describe, expect, it } from "vitest";

import { strictBody } from "../../../../src/domain/drafts/payloads.js";
import {
  changeTemplateBodySchema,
  saveTemplateBodySchema,
  templateStatusBodySchema,
} from "../../../../src/domain/recurring/payload.js";
import { TEMPLATE_SAVE_STATUS } from "../../../../src/domain/recurring/run-date.js";

function body(invoice: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    invoice: {
      objectName: "Invoice",
      mapAll: true,
      invoiceType: "WKR",
      status: TEMPLATE_SAVE_STATUS,
      contact: { id: 1001, objectName: "Contact" },
      contactPerson: { id: 2001, objectName: "SevUser" },
      invoiceDate: "01.12.2026",
      deliveryDate: 1796079600,
      header: "Rechnung",
      discount: 0,
      currency: "EUR",
      showNet: true,
      taxRule: { id: 1, objectName: "TaxRule" },
      taxRate: 0,
      taxText: "Umsatzsteuerpflichtige Umsätze",
      smallSettlement: false,
      accountIntervall: "P0Y1M0W",
      accountStartDate: 1796079600,
      ...invoice,
    },
    invoicePosSave: [
      {
        objectName: "InvoicePos",
        mapAll: true,
        quantity: 1,
        price: "100.00",
        name: "Wartung",
        unity: { id: 1, objectName: "Unity" },
        taxRate: 19,
        positionNumber: 0,
      },
    ],
    invoicePosDelete: null,
  };
}

const parse = (value: unknown) => saveTemplateBodySchema.safeParse(value).success;

describe("saveInvoice body of a recurring invoice template (D-111, D-003)", () => {
  it("accepts a template with start date, and with an end date", () => {
    expect(parse(body())).toBe(true);
    expect(parse(body({ accountEndDate: 1827615600 }))).toBe(true);
  });

  it("saves with the recorded status of a new template (D-112)", () => {
    expect(TEMPLATE_SAVE_STATUS).toBe(100);
    expect(parse(body({ status: 200 }))).toBe(false);
    expect(parse(body({ status: 50 }))).toBe(false);
  });

  it("is always of type WKR", () => {
    expect(parse(body({ invoiceType: "RE" }))).toBe(false);
    expect(parse(body({ invoiceType: undefined }))).toBe(false);
  });

  it("never sends accountNextInvoice, which sevDesk sets from the start date itself", () => {
    expect(parse(body({ accountNextInvoice: 1796079600 }))).toBe(false);
  });

  it.each(["recurringInterval", "recurringStartDate", "recurringNextVoucher", "recurringEndDate"])(
    "never sends %s, which sevDesk drops silently",
    (key) => {
      expect(parse(body({ [key]: "P0Y1M0W" }))).toBe(false);
    },
  );

  it("needs a start date and a fixed interval form", () => {
    expect(parse(body({ accountStartDate: undefined }))).toBe(false);
    expect(parse(body({ accountIntervall: undefined }))).toBe(false);
    for (const interval of ["P1M", "monthly", "1 month", "P0Y0M1W"]) {
      expect(parse(body({ accountIntervall: interval })), interval).toBe(false);
    }
    for (const interval of ["P0Y1M0W", "P0Y3M0W", "P0Y6M0W", "P1Y0M0W"]) {
      expect(parse(body({ accountIntervall: interval })), interval).toBe(true);
    }
  });

  it("takes the dates as Unix seconds, not as text", () => {
    expect(parse(body({ accountStartDate: "01.12.2026" }))).toBe(false);
    expect(parse(body({ accountEndDate: "2027-12-01" }))).toBe(false);
  });

  it("sends automatic generation only as true, or not at all (D-132)", () => {
    expect(parse(body({ propertyAutoGenerateRecurringInvoice: true }))).toBe(true);
    // false in a creating save is not recorded; "0" stores "0", whose meaning is not recorded.
    for (const value of [false, "0", "1", 1, 0, null]) {
      expect(parse(body({ propertyAutoGenerateRecurringInvoice: value })), String(value)).toBe(
        false,
      );
    }
  });

  it("never sends autoSendConfiguration: this server does not switch on automatic sending", () => {
    for (const value of [null, { sendType: "VM", timeValue: "P0D" }]) {
      expect(parse(body({ autoSendConfiguration: value })), JSON.stringify(value)).toBe(false);
    }
  });

  it("has no id and no number: a save creates a new template", () => {
    expect(parse(body({ id: 2301 }))).toBe(false);
    expect(parse(body({ invoiceNumber: "RE-1" }))).toBe(false);
  });

  it("refuses derived totals and keeps strictBody's internal error", () => {
    expect(() => strictBody(saveTemplateBodySchema, body({ sumGross: "119" }), "template")).toThrow(
      /Internal error: the template payload does not match its schema/,
    );
  });

  it("needs at least one position and nothing to delete", () => {
    expect(parse({ ...body(), invoicePosSave: [] })).toBe(false);
    expect(parse({ ...body(), invoicePosDelete: [{ id: 1, objectName: "InvoicePos" }] })).toBe(
      false,
    );
  });
});

describe("saveInvoice body changing a stored template (recorded 2026-11-17)", () => {
  const change = (invoice: Record<string, unknown>, rest: Record<string, unknown> = {}) =>
    changeTemplateBodySchema.safeParse({
      invoice: { id: 2301, objectName: "Invoice", mapAll: true, ...invoice },
      invoicePosSave: null,
      invoicePosDelete: null,
      ...rest,
    }).success;

  it("carries the id and only the fields that change", () => {
    expect(change({ header: "Neu" })).toBe(true);
    expect(change({ accountIntervall: "P0Y3M0W" })).toBe(true);
    expect(change({ accountEndDate: 1827615600 })).toBe(true);
    expect(change({ accountEndDate: null })).toBe(true);
    expect(change({ id: undefined, header: "Neu" })).toBe(false);
  });

  it("never sends a type, a status or the next run", () => {
    expect(change({ invoiceType: "WKR" })).toBe(false);
    expect(change({ status: 100 })).toBe(false);
    expect(change({ accountNextInvoice: 1796079600 })).toBe(false);
    expect(change({ accountEndDate: "" })).toBe(false);
  });

  it("sends a tax setting whole or not at all", () => {
    expect(change({ taxRule: { id: 1, objectName: "TaxRule" } })).toBe(false);
    expect(
      change({ taxRule: { id: 1, objectName: "TaxRule" }, taxRate: 0, smallSettlement: false }),
    ).toBe(true);
  });

  it("replaces positions as a whole: new rows to save, stored rows to delete", () => {
    const save = body().invoicePosSave;
    expect(
      change(
        {},
        { invoicePosSave: save, invoicePosDelete: [{ id: 5301, objectName: "InvoicePos" }] },
      ),
    ).toBe(true);
    expect(change({}, { invoicePosSave: [], invoicePosDelete: null })).toBe(false);
    // A stored position sent by id is not changed by sevDesk: the schema has no place for one.
    expect(
      change({}, { invoicePosSave: [{ ...(Array.isArray(save) ? save[0] : {}), id: 5301 }] }),
    ).toBe(false);
  });
});

describe("saveInvoice body ending or reactivating a template (D-112)", () => {
  const status = (value: unknown, rest: Record<string, unknown> = {}) =>
    templateStatusBodySchema.safeParse({
      invoice: { id: 2301, objectName: "Invoice", mapAll: true, status: value, ...rest },
      invoicePosSave: null,
      invoicePosDelete: null,
    }).success;

  it("sends status 50 or the save status as text, and nothing else", () => {
    expect(status("50")).toBe(true);
    expect(status(String(TEMPLATE_SAVE_STATUS))).toBe(true);
    expect(status("200")).toBe(false);
    expect(status(50)).toBe(false);
    expect(status("50", { header: "Neu" })).toBe(false);
  });
});
