import { describe, expect, it } from "vitest";

import { orderDiscountFacts, readOrderDiscounts } from "../../../src/domain/order-follow-ups.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { FakeSevdeskClient } from "../../helpers/fake-client.js";
import { discountRow, discountsOf } from "../../write-cases/orders.js";

const LABEL = "Discounts on the whole document (Rabatte, Aufschläge)";

describe("discounts on the whole order (D-116)", () => {
  it("reads one page with an explicit limit and drops rows of other records", async () => {
    const client = new FakeSevdeskClient([
      discountsOf("3001", [
        discountRow("3001"),
        discountRow("3001", { id: "8002", object: { id: "3002", objectName: "Order" } }),
        discountRow("3001", { id: "8003", object: { id: "3001", objectName: "Invoice" } }),
        discountRow("3001", { id: "8004", object: null }),
      ]),
    ]);
    const discounts = await readOrderDiscounts(client, 3001);
    expect(discounts.rows.map((row) => row.id)).toEqual([8001, 8004]);
    expect(discounts.complete).toBe(true);
    expect(client.calls).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/Order/3001/getDiscounts",
        query: { limit: 100, offset: 0, countAll: true },
      }),
    ]);
  });

  it("reads the recorded answer for an order without discounts as none", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/Order/3001/getDiscounts",
        response: { fixture: "recorded/2026-11-16/orders/order-discounts.json" },
      },
    ]);
    const discounts = await readOrderDiscounts(client, 3001);
    expect(discounts).toEqual({ rows: [], complete: true });
    expect(orderDiscountFacts(discounts, "EUR", "de")).toEqual([]);
  });

  it("refuses a row it cannot read instead of leaving it out", async () => {
    const client = new FakeSevdeskClient([
      discountsOf("3001", [discountRow("3001", { value: "ten" })]),
    ]);
    const error = await readOrderDiscounts(client, 3001).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SevdeskError);
    expect(error).toMatchObject({
      kind: "unexpected_response",
      message: "sevDesk returned the discounts of an order in an unexpected format.",
    });
  });

  it("says when the page was full", async () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      discountRow("3001", { id: String(8001 + index) }),
    );
    const discounts = await readOrderDiscounts(
      new FakeSevdeskClient([discountsOf("3001", rows)]),
      3001,
    );
    expect(discounts.complete).toBe(false);
    const [fact] = orderDiscountFacts(discounts, "EUR", "en");
    expect(fact?.value.split("\n")).toHaveLength(101);
    expect(fact?.value.split("\n").at(-1)).toBe(
      "sevDesk returned 100 rows; there may be more. Check them in sevDesk.",
    );
    const [factDe] = orderDiscountFacts(discounts, "EUR", "de");
    expect(factDe?.value.split("\n").at(-1)).toBe(
      "sevDesk hat 100 Zeilen geliefert; es kann weitere geben. Prüfe sie in sevDesk.",
    );
  });

  it("writes each row with its kind, amount and base, in both languages", async () => {
    const discounts = await readOrderDiscounts(
      new FakeSevdeskClient([
        discountsOf("3001", [
          discountRow("3001", { value: "2.5" }),
          discountRow("3001", { id: "8002", discount: "0", percentage: "0", value: "1250" }),
          // Flags sevDesk left out: neither the kind, the unit nor the base is guessed.
          discountRow("3001", {
            id: "8003",
            discount: null,
            percentage: null,
            isNet: null,
            value: "3",
            text: null,
          }),
          discountRow("3001", { id: "8004", value: null, isNet: "0", text: "  Sonder \n rabatt " }),
        ]),
      ]),
      3001,
    );
    expect(orderDiscountFacts(discounts, "USD", "en")).toEqual([
      {
        label: LABEL,
        value: [
          "2.5 % discount (net): Treuerabatt",
          "1250.00 USD surcharge (net): Treuerabatt",
          "3 discount or surcharge",
          "? discount (gross): Sonder rabatt",
        ].join("\n"),
      },
    ]);
    expect(orderDiscountFacts(discounts, "USD", "de")).toEqual([
      {
        label: "Rabatte und Aufschläge auf das ganze Dokument",
        value: [
          "2,5 % Rabatt (netto): Treuerabatt",
          "1.250,00 USD Aufschlag (netto): Treuerabatt",
          "3 Rabatt oder Aufschlag",
          "? Rabatt (brutto): Sonder rabatt",
        ].join("\n"),
      },
    ]);
  });

  it("gives no fact for an order without discounts", () => {
    expect(orderDiscountFacts({ rows: [], complete: true }, "EUR", "en")).toEqual([]);
  });
});
