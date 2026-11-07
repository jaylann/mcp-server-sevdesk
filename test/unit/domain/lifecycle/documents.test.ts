import { describe, expect, it } from "vitest";

import { documentRef, readLifecycleDocument } from "../../../../src/domain/lifecycle/documents.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import {
  creditNoteRow,
  documentRoute,
  invoiceRow,
  orderRow,
} from "../../tools/lifecycle/helpers.js";

describe("readLifecycleDocument (community record shapes, fake values)", () => {
  it("reads an invoice with one GET (contact embedded) and maps the lifecycle facts", async () => {
    const client = new FakeSevdeskClient([documentRoute("invoice", invoiceRow())]);

    const doc = await readLifecycleDocument(client, "invoice", 1001, undefined, "2026-11-07");

    expect(client.calls.map(({ method, path, query }) => ({ method, path, query }))).toEqual([
      { method: "GET", path: "/Invoice/1001", query: { embed: "contact" } },
    ]);
    expect(doc).toMatchObject({
      kind: "invoice",
      id: 1001,
      number: "RE-1001",
      typeCode: "RE",
      typeLabel: "Rechnung",
      status: 200,
      statusLabel: "Open / due",
      contact: { id: 1001, name: "Musterfirma GmbH" },
      date: "2026-10-01",
      dueDate: "2026-10-15",
      currency: "EUR",
      totals: {
        net: { amount: "149.02", currency: "EUR" },
        tax: { amount: "28.31", currency: "EUR" },
        gross: { amount: "177.33", currency: "EUR" },
      },
      paidAmount: "0",
      enshrined: false,
    });
    expect(doc.dto.id).toBe(1001);
  });

  it("keeps the raw paid amount and the enshrined flag", async () => {
    const row = invoiceRow({
      status: "750",
      paidAmount: "50.5",
      enshrined: "2026-10-02T10:00:00+02:00",
    });
    const client = new FakeSevdeskClient([documentRoute("invoice", row)]);

    const doc = await readLifecycleDocument(client, "invoice", 1001);

    expect(doc.paidAmount).toBe("50.5");
    expect(doc.enshrined).toBe(true);
    expect(doc.status).toBe(750);
  });

  it("reports no paid amount for a credit note (sevDesk sends none)", async () => {
    const client = new FakeSevdeskClient([documentRoute("creditNote", creditNoteRow())]);

    const doc = await readLifecycleDocument(client, "creditNote", 2001);

    expect(doc).toMatchObject({
      kind: "creditNote",
      id: 2001,
      number: "GU-1001",
      typeCode: undefined,
      status: 200,
      paidAmount: undefined,
      dueDate: undefined,
      eInvoice: undefined,
    });
    expect(client.calls[0]?.path).toBe("/CreditNote/2001");
  });

  it("reads an order with its type", async () => {
    const client = new FakeSevdeskClient([documentRoute("order", orderRow())]);

    const doc = await readLifecycleDocument(client, "order", 3002);

    expect(doc).toMatchObject({
      kind: "order",
      id: 3002,
      number: "AB-1002",
      typeCode: "AB",
      status: 500,
      enshrined: false,
    });
  });

  it("passes sevDesk's not-found error on for an unknown id", async () => {
    const client = new FakeSevdeskClient([
      { path: "/Invoice/9999", query: { embed: "contact" }, response: { body: { objects: [] } } },
    ]);

    const error = await readLifecycleDocument(client, "invoice", 9999).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("not_found");
  });

  it("refuses a paid amount that is not a decimal", async () => {
    const client = new FakeSevdeskClient([
      documentRoute("invoice", invoiceRow({ paidAmount: "a lot" })),
    ]);

    await expect(readLifecycleDocument(client, "invoice", 1001)).rejects.toMatchObject({
      kind: "unexpected_response",
    });
  });
});

describe("documentRef", () => {
  it("names a document by its id only", () => {
    expect(documentRef({ kind: "creditNote", id: 7 })).toBe("credit note 7");
    expect(documentRef({ kind: "invoice", id: 7 }, true)).toBe("Invoice 7");
  });
});
