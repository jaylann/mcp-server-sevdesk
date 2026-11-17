/**
 * The shared reader and renderer of discounts on the whole document (D-116), shown on an order:
 * every approval and preview that lists the rows (finalize, the order follow-ups, the draft
 * updates, the from-order preview) reads them with `readDocumentDiscounts` and writes each with
 * `discountRowText`.
 */
import { describe, expect, it } from "vitest";

import {
  discountAmountOfItem,
  discountRowText,
  readDocumentDiscounts,
} from "../../../src/domain/document-discounts.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { FakeSevdeskClient } from "../../helpers/fake-client.js";
import { discountRow, discountsOf } from "../../write-cases/orders.js";

async function failure(promise: Promise<unknown>): Promise<SevdeskError> {
  const error = await promise.catch((caught: unknown) => caught);
  if (!(error instanceof SevdeskError)) throw new Error("expected a SevdeskError");
  return error;
}

describe("reading the discounts of an order (D-116)", () => {
  it("reads one page with an explicit limit, by id", async () => {
    const client = new FakeSevdeskClient([
      discountsOf("3001", [discountRow("3001", { id: "8002" }), discountRow("3001")]),
    ]);
    const discounts = await readDocumentDiscounts(client, "order", 3001);
    expect(discounts.rows.map((row) => row.id)).toEqual([8001, 8002]);
    expect(discounts.rows[0]).toEqual({
      id: 8001,
      text: "Treuerabatt",
      surcharge: false,
      percentage: true,
      value: "5",
      isNet: true,
    });
    expect(client.calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", "/Order/3001/getDiscounts"],
    ]);
    expect(client.calls[0]?.query).toMatchObject({ limit: 1000 });
  });

  it("reads the recorded answer for an order without discounts as none", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/Order/3001/getDiscounts",
        response: { fixture: "recorded/2026-11-16/orders/order-discounts.json" },
      },
    ]);
    expect(await readDocumentDiscounts(client, "order", 3001)).toEqual({ raw: [], rows: [] });
  });

  // Nothing is shown, approved or replaced on rows that could not be read cleanly: a row of
  // another record, or one without its record, is refused, not left out.
  it.each([
    ["another order", { id: "8002", object: { id: "3002", objectName: "Order" } }],
    ["an invoice with the same id", { id: "8003", object: { id: "3001", objectName: "Invoice" } }],
    ["no record", { id: "8004", object: null }],
    ["no value", { id: "8005", value: null }],
  ])("refuses a row of %s", async (_label, overrides) => {
    const client = new FakeSevdeskClient([
      discountsOf("3001", [discountRow("3001"), discountRow("3001", overrides)]),
    ]);
    const error = await failure(readDocumentDiscounts(client, "order", 3001));
    expect(error.kind).toBe("unexpected_response");
    expect(error.message).toBe(
      "sevDesk listed a document discount that does not belong to the document or has no value.",
    );
  });

  it("refuses a row it cannot read instead of leaving it out", async () => {
    const client = new FakeSevdeskClient([
      discountsOf("3001", [discountRow("3001", { value: "ten" })]),
    ]);
    expect((await failure(readDocumentDiscounts(client, "order", 3001))).kind).toBe(
      "unexpected_response",
    );
  });

  it("refuses a page as long as the limit: the rest would be unknown", async () => {
    const rows = Array.from({ length: 1000 }, (_, index) =>
      discountRow("3001", { id: String(8001 + index) }),
    );
    const client = new FakeSevdeskClient([discountsOf("3001", rows)]);
    const error = await failure(readDocumentDiscounts(client, "order", 3001));
    expect(error.kind).toBe("unexpected_response");
    expect(error.message).toContain("1000 or more discounts");
  });
});

describe("writing one discount row", () => {
  const row = { surcharge: false, percentage: true, value: "2.5", isNet: true };

  it("writes a percentage, a fixed amount and a surcharge in both languages", () => {
    expect(discountRowText(row, "EUR", "en")).toBe("2.5 % of the net total");
    expect(discountRowText(row, "EUR", "de")).toBe("2,5 % vom Nettobetrag");
    const surcharge = { surcharge: true, percentage: false, value: "1250", isNet: false };
    expect(discountRowText(surcharge, "EUR", "en")).toBe(
      "surcharge (Aufschlag): 1250.00 EUR gross",
    );
    expect(discountRowText(surcharge, "EUR", "de")).toBe("Aufschlag: 1.250,00 EUR brutto");
  });

  it("names no currency for a fixed amount outside EUR (D-116)", () => {
    const fixed = { surcharge: false, percentage: false, value: "12", isNet: true };
    expect(discountRowText(fixed, "USD", "en")).toBe("12.00 net (fixed amount)");
    expect(discountRowText(fixed, "USD", "de")).toBe("12,00 netto (fester Betrag)");
    // A percentage is the same in any currency.
    expect(discountRowText(row, "USD", "en")).toBe("2.5 % of the net total");
  });

  it("reads a DTO item back as the same row", () => {
    const item = { id: 1, kind: "amount" as const, value: "5", basis: "gross" as const };
    expect(discountRowText(discountAmountOfItem(item), "EUR", "en")).toBe("5.00 EUR gross");
    expect(discountAmountOfItem({ id: 2, kind: "percent", value: "3", surcharge: true })).toEqual({
      surcharge: true,
      percentage: true,
      value: "3",
      isNet: undefined,
    });
  });
});
