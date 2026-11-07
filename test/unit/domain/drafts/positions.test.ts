import { describe, expect, it } from "vitest";

import {
  divideRounded,
  type DraftPosition,
  draftPositionInput,
  expectedTotals,
  orderPositionInput,
  positionAmounts,
  positionPayload,
  toDraftPositions,
  wireNumber,
} from "../../../../src/domain/drafts/positions.js";
import { decimal, toDecimalString } from "../../../../src/domain/money.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";

function position(fields: Partial<DraftPosition>): DraftPosition {
  return { name: "A", quantity: "1", unitPrice: "1", taxRate: "19", unitId: 1, ...fields };
}

describe("draft positions: expected totals (exact decimals, never sent)", () => {
  it.each([
    // [quantity, unit price, rate, mode, discount, net, tax, gross]
    ["3", "10", "19", "net", undefined, "30.00", "5.70", "35.70"],
    ["0.1", "3", "19", "net", undefined, "0.30", "0.06", "0.36"],
    ["1", "33.605", "0", "net", undefined, "33.61", "0.00", "33.61"],
    ["1", "1.005", "19", "net", undefined, "1.01", "0.19", "1.20"],
    ["1.5", "9.99", "7", "net", undefined, "14.99", "1.05", "16.04"],
    ["2", "10", "19", "net", "10", "18.00", "3.42", "21.42"],
    ["1", "11.90", "19", "gross", undefined, "10.00", "1.90", "11.90"],
    ["2", "5", "7", "gross", undefined, "9.35", "0.65", "10.00"],
    ["1", "10", "19", "gross", undefined, "8.40", "1.60", "10.00"],
    ["1", "119", "19", "gross", "50", "50.00", "9.50", "59.50"],
    ["1", "-10", "19", "net", undefined, "-10.00", "-1.90", "-11.90"],
    ["1", "-10", "19", "gross", undefined, "-8.40", "-1.60", "-10.00"],
  ] as const)(
    "%s × %s at %s %% (%s, discount %s) → net %s, tax %s, gross %s",
    (quantity, unitPrice, taxRate, mode, discountPercent, net, tax, gross) => {
      expect(
        positionAmounts(position({ quantity, unitPrice, taxRate, discountPercent }), mode),
      ).toEqual({ net, tax, gross });
    },
  );

  it("sums positions and leaves optional ones out", () => {
    const positions = [
      position({ quantity: "3", unitPrice: "10" }),
      position({ unitPrice: "25" }),
      position({ unitPrice: "1000", optional: true }),
    ];
    expect(expectedTotals(positions, "net")).toEqual({
      net: "55.00",
      tax: "10.45",
      gross: "65.45",
    });
    expect(expectedTotals([], "gross")).toEqual({ net: "0.00", tax: "0.00", gross: "0.00" });
  });

  it("divides with bigint arithmetic, half-up away from zero", () => {
    const show = (a: string, b: string, places: number) =>
      toDecimalString(divideRounded(decimal(a), decimal(b), places));
    expect(show("1190", "119", 2)).toBe("10");
    expect(show("1", "3", 2)).toBe("0.33");
    expect(show("2", "3", 2)).toBe("0.67");
    expect(show("-2", "3", 2)).toBe("-0.67");
    expect(show("2", "-3", 2)).toBe("-0.67");
    expect(show("0.005", "1", 2)).toBe("0.01");
    expect(() => divideRounded(decimal(1), decimal(0), 2)).toThrow("division by zero");
  });
});

describe("draft positions: input and normalization", () => {
  it("parses amounts exactly and rejects a zero quantity", () => {
    const parsed = draftPositionInput.parse({
      name: " Beratung ",
      quantity: 1.5,
      unitPrice: "19.99",
    });
    expect(parsed).toEqual({ name: "Beratung", quantity: "1.5", unitPrice: "19.99" });
    expect(draftPositionInput.safeParse({ name: "A", quantity: 0, unitPrice: 1 }).success).toBe(
      false,
    );
    expect(
      draftPositionInput.safeParse({ name: "A", quantity: 1, unitPrice: 1, optional: true })
        .success,
    ).toBe(false);
    expect(
      orderPositionInput.safeParse({ name: "A", quantity: 1, unitPrice: 1, optional: true })
        .success,
    ).toBe(true);
    expect(
      draftPositionInput.safeParse({ name: "A", quantity: 1, unitPrice: "1,50" }).success,
    ).toBe(false);
  });

  it("applies the default unit, drops blank texts and keeps the resolved rates", () => {
    expect(
      toDraftPositions(
        [
          { name: "A", quantity: "1", unitPrice: "2", text: "  " },
          {
            name: "B",
            quantity: "1",
            unitPrice: "2",
            unitId: 9,
            partId: 6001,
            text: "x",
            optional: false,
          },
        ],
        ["19", "7"],
      ),
    ).toEqual([
      { name: "A", quantity: "1", unitPrice: "2", taxRate: "19", unitId: 1 },
      {
        name: "B",
        quantity: "1",
        unitPrice: "2",
        taxRate: "7",
        unitId: 9,
        partId: 6001,
        text: "x",
      },
    ]);
    expect(() => toDraftPositions([{ name: "A", quantity: "1", unitPrice: "1" }], [])).toThrow(
      "no tax rate for position 1",
    );
  });
});

describe("draft positions: payload (B8: price only)", () => {
  it("sends price as an exact decimal string with at least two decimals", () => {
    expect(positionPayload(position({ unitPrice: "49.9" }), 0, "InvoicePos").price).toBe("49.90");
    expect(positionPayload(position({ unitPrice: "0.1234" }), 0, "InvoicePos").price).toBe(
      "0.1234",
    );
    expect(positionPayload(position({ unitPrice: "-5" }), 0, "InvoicePos").price).toBe("-5.00");
  });

  it("links parts, sends discounts in percent and optional only for orders", () => {
    const linked = position({ partId: 6001, discountPercent: "12.5", optional: true, text: "t" });
    expect(positionPayload(linked, 2, "CreditNotePos")).toEqual({
      objectName: "CreditNotePos",
      mapAll: true,
      quantity: 1,
      price: "1.00",
      name: "A",
      unity: { id: 1, objectName: "Unity" },
      taxRate: 19,
      positionNumber: 2,
      text: "t",
      part: { id: 6001, objectName: "Part" },
      discount: 12.5,
    });
    expect(positionPayload(linked, 0, "OrderPos")).toMatchObject({ optional: true });
  });

  it("refuses numbers that would not survive JSON exactly", () => {
    expect(wireNumber("19", "x")).toBe(19);
    expect(wireNumber("0.0001", "x")).toBe(0.0001);
    const error = (() => {
      try {
        wireNumber("12345678901234567.5", "the quantity of position 1");
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).message).toBe(
      "the quantity of position 1 has too many digits to send exactly; use a smaller value.",
    );
  });
});
