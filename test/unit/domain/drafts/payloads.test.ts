import { describe, expect, it } from "vitest";

import { duplicateWarning, findDuplicates } from "../../../../src/domain/drafts/duplicates.js";
import {
  saveCreditNoteBodySchema,
  savedDocumentId,
  saveInvoiceBodySchema,
  strictBody,
} from "../../../../src/domain/drafts/payloads.js";
import { readBack, readBackNotes } from "../../../../src/domain/drafts/read-back.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";

const invoice = {
  objectName: "Invoice",
  mapAll: true,
  invoiceType: "RE",
  status: 100,
  contact: { id: 1001, objectName: "Contact" },
  contactPerson: { id: 2001, objectName: "SevUser" },
  invoiceDate: "07.11.2026",
  discount: 0,
  currency: "EUR",
  showNet: true,
  taxRule: { id: 1, objectName: "TaxRule" },
  taxRate: 0,
  smallSettlement: false,
};
const position = {
  objectName: "InvoicePos",
  mapAll: true,
  quantity: 1,
  price: "10.00",
  name: "A",
  unity: { id: 1, objectName: "Unity" },
  taxRate: 19,
  positionNumber: 0,
};

describe("draft payloads: strict outgoing schemas (D-003, D-004, B8)", () => {
  it("accepts a well-formed body and returns it as sent on the wire", () => {
    const body = strictBody(
      saveInvoiceBodySchema,
      {
        invoice: { ...invoice, header: undefined },
        invoicePosSave: [position],
        invoicePosDelete: null,
      },
      "invoice",
    );
    expect(body.invoice).not.toHaveProperty("header");
  });

  it.each([
    [
      "a derived total on the document",
      {
        invoice: { ...invoice, sumGross: 11.9 },
        invoicePosSave: [position],
        invoicePosDelete: null,
      },
    ],
    [
      "priceGross on a position",
      { invoice, invoicePosSave: [{ ...position, priceGross: 11.9 }], invoicePosDelete: null },
    ],
    [
      "the spec's non-existent invoicePos",
      { invoice, invoicePos: [position], invoicePosDelete: null },
    ],
    [
      "both taxRule and taxType",
      {
        invoice: { ...invoice, taxType: "default" },
        invoicePosSave: [position],
        invoicePosDelete: null,
      },
    ],
    [
      "neither taxRule nor taxType",
      {
        invoice: { ...invoice, taxRule: undefined },
        invoicePosSave: [position],
        invoicePosDelete: null,
      },
    ],
    [
      "a status other than draft",
      { invoice: { ...invoice, status: 200 }, invoicePosSave: [position], invoicePosDelete: null },
    ],
  ])("refuses %s as an internal error", (_label, body) => {
    expect(() => strictBody(saveInvoiceBodySchema, body, "invoice")).toThrow(
      /^Internal error: the invoice payload does not match its schema/,
    );
  });

  it("refuses ACCOUNTING_TYPE credit notes (not supported on Update 2.0)", () => {
    const result = saveCreditNoteBodySchema.safeParse({
      creditNote: { bookingCategory: "ACCOUNTING_TYPE" },
      creditNotePosSave: [],
      creditNotePosDelete: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("draft payloads: saved ids", () => {
  it("reads the id from an object or an array of one", () => {
    expect(savedDocumentId({ invoice: { id: "2101" } }, "invoice", "invoice")).toBe(2101);
    expect(savedDocumentId([{ order: { id: 3101 } }], "order", "order")).toBe(3101);
  });

  it("says the document may exist when the id is missing", () => {
    expect(() => savedDocumentId({ creditNote: {} }, "creditNote", "credit note")).toThrow(
      "sevDesk accepted the credit note but its answer did not contain the credit note's id",
    );
  });
});

describe("draft duplicates", () => {
  it("compares currency and gross exactly and sorts ids", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/CreditNote",
        response: {
          body: {
            objects: [
              {
                id: "7",
                objectName: "CreditNote",
                status: "100",
                currency: "EUR",
                sumGross: "11.90",
                creditNoteDate: "2026-11-07T00:00:00+01:00",
              },
              {
                id: "5",
                objectName: "CreditNote",
                status: "100",
                currency: "EUR",
                sumGross: "11.9",
                creditNoteDate: "2026-11-07T00:00:00+01:00",
              },
              {
                id: "6",
                objectName: "CreditNote",
                status: "100",
                currency: "USD",
                sumGross: "11.90",
                sumGrossForeignCurrency: "11.90",
                creditNoteDate: "2026-11-07T00:00:00+01:00",
              },
              {
                id: "8",
                objectName: "CreditNote",
                status: "100",
                currency: "EUR",
                creditNoteDate: "2026-11-07T00:00:00+01:00",
              },
            ],
          },
        },
      },
    ]);
    const query = { contactId: 1001, date: "2026-11-07", gross: "11.90", currency: "EUR" };
    const ids = await findDuplicates(client, { kind: "creditNote" }, query);
    expect(ids).toEqual([5, 7]);
    expect(duplicateWarning("credit note", [], query)).toBeUndefined();
  });
});

describe("draft read-back", () => {
  it("notes unexpanded placeholders in a number (D-027)", () => {
    expect(
      readBackNotes(
        { number: "RE-%YYYY%MM1038", gross: "1.00", currency: "EUR", positionsComplete: true },
        {
          noun: "invoice",
          finalizeTool: "sevdesk_invoice_finalize",
          expected: { net: "1", tax: "0", gross: "1.00" },
        },
      ),
    ).toEqual([
      "The invoice number still contains placeholders (%…%). Check the number range " +
        "(Nummernkreis) in sevDesk's settings before finalizing.",
    ]);
    expect(
      readBackNotes(
        { number: "RE-1038", currency: "EUR", positionsComplete: false },
        { noun: "invoice", finalizeTool: "x" },
      ),
    ).toEqual(["sevDesk has more positions than could be read back; positions is partial."]);
  });

  it("attaches the saved record to sevDesk errors only", async () => {
    const saved = { objectName: "Invoice", id: "2101" };
    const failing = readBack(saved, () =>
      Promise.reject(new SevdeskError({ kind: "server", message: "sevDesk failed." })),
    );
    await expect(failing).rejects.toMatchObject({ kind: "server", completedWrites: [saved] });
    await expect(readBack(saved, () => Promise.reject(new Error("bug")))).rejects.toThrow("bug");
  });
});
