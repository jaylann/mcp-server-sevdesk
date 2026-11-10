import { describe, expect, it } from "vitest";

import { creditNoteGetTool as tool } from "../../../../src/tools/credit-notes/get.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const routes: readonly FakeRoute[] = [
  {
    path: "/CreditNote/2001",
    query: { embed: "contact" },
    response: { fixture: "credit-notes/credit-note-2001.json" },
  },
  {
    path: "/CreditNotePos",
    query: { "creditNote[id]": 2001, "creditNote[objectName]": "CreditNote" },
    response: { fixture: "credit-notes/credit-note-positions-2001.json" },
  },
  { path: "/Unity", response: { fixture: "meta/units.json" } },
];

describe("sevdesk_credit_note_get (community: recorded CreditNote shapes, fake data)", () => {
  it("is a read tool with explicit annotations", () => {
    expect(tool.tier).toBe("read");
    expect(tool.toolset).toBe("credit-notes");
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
  });

  it("returns the credit note with positions, tax rule and source invoice", async () => {
    const client = new FakeSevdeskClient(routes);
    const result = await tool.handler(tool.input.parse({ id: 2001 }), testContext(client));
    expect(client.methods().every((method) => method === "GET")).toBe(true);
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.creditNote).toMatchObject({
      id: 2001,
      number: "GU-1001",
      sourceInvoiceId: 1004,
      deliveryDate: "2026-10-22",
      priceMode: "net",
      tax: { generation: "2.0", rule: { id: 1 } },
      address: { text: "Musterfirma GmbH\nMusterstraße 1\n12345 Musterstadt", countryId: 1 },
      contactPersonId: 7001,
      internalNote: "Reklamation vom 20.10.",
    });
    expect(result.data.positions).toEqual([
      {
        id: 8001,
        number: 1000,
        name: "Minderung Beratung",
        text: "Gutschrift für nicht erbrachte Leistung",
        quantity: "1",
        unit: { id: 7, name: "pauschal" },
        unitPriceNet: { amount: "20.00", currency: "EUR" },
        unitPriceGross: { amount: "23.80", currency: "EUR" },
        taxRate: "19",
        totals: {
          net: { amount: "20.00", currency: "EUR" },
          tax: { amount: "3.80", currency: "EUR" },
          gross: { amount: "23.80", currency: "EUR" },
        },
      },
    ]);
    expect(result.data.positionsComplete).toBe(true);
    expect(result.summary).toBe("Credit note 2001 (status Open / delivered) with 1 position.");
  });

  it("rejects invalid ids", () => {
    expect(() => tool.input.parse({ id: -1 })).toThrow();
    expect(() => tool.input.parse({})).toThrow();
  });
});
