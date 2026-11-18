/**
 * The document discount of the draft tools (spec/deviations.md D-116, recorded 2026-11-16 and
 * 2026-11-18): the argument, the body keys in the recorded form, the totals with the discount, the
 * change an update makes, and the refusals of what this server does not compute.
 */
import { describe, expect, it } from "vitest";

import type { DiscountRow, StoredDiscounts } from "../../../../src/domain/document-discounts.js";
import {
  createDiscountBody,
  createTotals,
  type DiscountChange,
  discountedTotals,
  discountInput,
  discountReadBackNote,
  discountText,
  type DraftDiscount,
  expectedOfCreate,
  planDiscountChange,
  type RateTotal,
  rateTotals,
  resolveDiscount,
  storedDiscountState,
  storedDiscountText,
  updateTotals,
} from "../../../../src/domain/drafts/discount.js";
import { saveInvoiceBodySchema, strictBody } from "../../../../src/domain/drafts/payloads.js";
import type { DraftPosition } from "../../../../src/domain/drafts/positions.js";
import { decimal, format } from "../../../../src/domain/money.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";

const ten = { percentage: true, value: "10", text: "Rabatt" } as const;
const fixed = { percentage: false, value: "10", text: "Rabatt" } as const;

/** One position of 100.00 net at 19 %: the recorded probe document. */
const recordedPosition: DraftPosition = {
  name: "Beratung",
  quantity: "1",
  unitPrice: "100",
  taxRate: "19",
  unitId: 1,
};

function row(overrides: Partial<DiscountRow> = {}): DiscountRow {
  return {
    id: 9001,
    text: "Rabatt",
    surcharge: false,
    percentage: true,
    value: "10",
    isNet: true,
    ...overrides,
  };
}

function stored(...rows: DiscountRow[]): StoredDiscounts {
  return { raw: rows, rows };
}

function refusal(run: () => unknown): SevdeskError {
  try {
    run();
  } catch (error) {
    if (error instanceof SevdeskError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the discount argument", () => {
  it("takes percent or amount, with sevDesk's own text by default", () => {
    expect(resolveDiscount(discountInput.parse({ percent: 3 }))).toEqual({
      percentage: true,
      value: "3",
      text: "Rabatt",
    });
    expect(resolveDiscount(discountInput.parse({ amount: "50.00", text: "Treuerabatt" }))).toEqual({
      percentage: false,
      value: "50",
      text: "Treuerabatt",
    });
  });

  it.each([
    [{ percent: 3, amount: 10 }, "not both"],
    [{}, "not both and not neither"],
    [{ percent: "100.01" }, "at most 100"],
  ])("refuses %j", (input, message) => {
    const error = refusal(() => resolveDiscount(discountInput.parse(input)));
    expect(error.kind).toBe("validation");
    expect(error.message).toContain(message);
  });

  it("rejects zero, negative, too many decimals and unknown keys at the schema", () => {
    for (const input of [{ percent: 0 }, { amount: -5 }, { amount: "1.234" }, { value: 3 }]) {
      expect(discountInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });
});

describe("the body keys (recorded form, D-116)", () => {
  it("sends the discount as a list of one, then discountDelete null, on a create", () => {
    expect(createDiscountBody(ten)).toEqual({
      discountSave: [
        {
          objectName: "Discounts",
          mapAll: true,
          discount: true,
          text: "Rabatt",
          percentage: true,
          value: 10,
        },
      ],
      discountDelete: null,
    });
    expect(createDiscountBody(undefined)).toEqual({});
  });

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
    price: "100.00",
    name: "Beratung",
    unity: { id: 1, objectName: "Unity" },
    taxRate: 19,
    positionNumber: 0,
  };
  const body = (extra: object, id?: number) =>
    strictBody(
      saveInvoiceBodySchema,
      {
        invoice: id === undefined ? invoice : { ...invoice, id },
        invoicePosSave: [position],
        invoicePosDelete: null,
        ...extra,
      },
      "invoice",
    );

  it("puts the discount keys after the position keys and keeps invoiceType RE", () => {
    const sent = body(createDiscountBody(ten));
    expect(Object.keys(sent)).toEqual([
      "invoice",
      "invoicePosSave",
      "invoicePosDelete",
      "discountSave",
      "discountDelete",
    ]);
    expect(sent.invoice.invoiceType).toBe("RE");
  });

  it.each([
    ["a lone discountSave", { discountSave: createDiscountBody(ten).discountSave }, undefined],
    ["a lone discountDelete", { discountDelete: null }, undefined],
    ["a percentage above 100", { ...createDiscountBody({ ...ten, value: "101" }) }, undefined],
    [
      "a delete on a new document",
      {
        discountSave: createDiscountBody(ten).discountSave,
        discountDelete: [{ id: 9001, objectName: "Discounts" }],
      },
      undefined,
    ],
    ["a removal that deletes nothing", { discountSave: null, discountDelete: null }, 2102],
    [
      "a surcharge",
      {
        discountSave: [{ ...createDiscountBody(ten).discountSave?.[0], discount: false }],
        discountDelete: null,
      },
      undefined,
    ],
    [
      "two discounts",
      {
        discountSave: [
          createDiscountBody(ten).discountSave?.[0],
          createDiscountBody(fixed).discountSave?.[0],
        ],
        discountDelete: null,
      },
      undefined,
    ],
  ])("refuses %s", (_label, extra, id) => {
    expect(() => body(extra, id)).toThrow(/Internal error/);
  });

  it("accepts a replacement and a removal on an update", () => {
    const deleted = [{ id: 9001, objectName: "Discounts" }];
    expect(body({ ...createDiscountBody(ten), discountDelete: deleted }, 2102)).toMatchObject({
      discountDelete: deleted,
    });
    expect(body({ discountSave: null, discountDelete: deleted }, 2102)).toMatchObject({
      discountSave: null,
    });
  });
});

/** Positions `price at rate`, in the order sent, e.g. `at("70", "19")`. */
function at(unitPrice: string, taxRate: string): DraftPosition {
  return { ...recordedPosition, unitPrice, taxRate };
}

/** One rate's undiscounted totals, for `discountedTotals`. */
function rate(value: string, net: string, gross: string): RateTotal {
  return { rate: value, net: decimal(net), gross: decimal(gross) };
}

const percent = (value: string): DraftDiscount => ({ percentage: true, value, text: "Rabatt" });
const amount = (value: string): DraftDiscount => ({ percentage: false, value, text: "Rabatt" });

describe("totals with the discount", () => {
  it("gives the recorded sums for 10 % and for a fixed 10.00 on 100.00 at 19 %", () => {
    const recorded = { net: "90.00", tax: "17.10", gross: "107.10" };
    expect(createTotals([recordedPosition], "net", ten)).toEqual({
      expected: recorded,
      gross: "107.10",
      warning: undefined,
    });
    expect(createTotals([recordedPosition], "net", fixed).expected).toEqual(recorded);
  });

  it("gives the sums recorded on 2026-11-18 for 10 % on gross prices and 10.00 in CHF", () => {
    // D-116, probes write-discount-net-gross (invoice 119.00 gross at 19 %, 10 %) and
    // write-discount-foreign-currency (CHF, the foreign sums: 90, 17.1, 107.1).
    const recorded = { net: "90.00", tax: "17.10", gross: "107.10" };
    expect(createTotals([at("119", "19")], "gross", ten).expected).toEqual(recorded);
    expect(createTotals([recordedPosition], "net", fixed).expected).toEqual(recorded);
  });

  // D-116, recorded 2026-11-18 on invoice drafts with net prices (probes write-discount-mixed-tax
  // and write-discount-mixed-tax-uneven): sumNet, sumTax and sumGross as sevDesk stored them.
  // Together these cases tell apart every candidate rounding (see the module comment).
  it.each([
    [
      "70 at 19 % + 30 at 7 %, 10 %",
      [at("70", "19"), at("30", "7")],
      percent("10"),
      "90.00",
      "13.86",
      "103.86",
    ],
    [
      "70 at 19 % + 30 at 7 %, fixed 9.99",
      [at("70", "19"), at("30", "7")],
      amount("9.99"),
      "90.01",
      "13.86",
      "103.87",
    ],
    [
      "33.33 at 19 % + 66.67 at 7 % + 0.01 at 0 %, fixed 10",
      [at("33.33", "19"), at("66.67", "7"), at("0.01", "0")],
      amount("10"),
      "90.01",
      "9.90",
      "99.91",
    ],
    [
      "33.33 at 19 % + 66.67 at 7 % + 0.01 at 0 %, 3 %",
      [at("33.33", "19"), at("66.67", "7"), at("0.01", "0")],
      percent("3"),
      "97.01",
      "10.67",
      "107.68",
    ],
    [
      "26.92 at 7 % + 76.54 at 19 %, 3 %",
      [at("26.92", "7"), at("76.54", "19")],
      percent("3"),
      "100.36",
      "15.94",
      "116.30",
    ],
    [
      "60.42 at 19 % + 142.47 at 7 %, fixed 9.99",
      [at("60.42", "19"), at("142.47", "7")],
      amount("9.99"),
      "192.90",
      "20.40",
      "213.30",
    ],
    [
      "119.46 at 7 % + 27.78 at 19 %, fixed 9.99",
      [at("119.46", "7"), at("27.78", "19")],
      amount("9.99"),
      "137.25",
      "12.71",
      "149.96",
    ],
    [
      "69.15 at 19 % + 107.01 at 7 %, 7 %",
      [at("69.15", "19"), at("107.01", "7")],
      percent("7"),
      "163.83",
      "19.19",
      "183.02",
    ],
    [
      "101.75 at 7 % + 39.05 at 19 % + 80.66 at 0 %, fixed 10",
      [at("101.75", "7"), at("39.05", "19"), at("80.66", "0")],
      amount("10"),
      "211.46",
      "13.89",
      "225.35",
    ],
    [
      "76.24 at 0 % + 62.21 at 7 % + 32.45 at 19 %, fixed 9.99",
      [at("76.24", "0"), at("62.21", "7"), at("32.45", "19")],
      amount("9.99"),
      "160.91",
      "9.90",
      "170.81",
    ],
    [
      "25.79 at 7 % + 40.18 at 19 % + 28.80 at 0 %, fixed 9.99",
      [at("25.79", "7"), at("40.18", "19"), at("28.80", "0")],
      amount("9.99"),
      "84.78",
      "8.44",
      "93.22",
    ],
    [
      "95.72 at 19 % + 35.78 at 7 % + 34.47 at 0 %, fixed 9.99",
      [at("95.72", "19"), at("35.78", "7"), at("34.47", "0")],
      amount("9.99"),
      "155.98",
      "19.44",
      "175.42",
    ],
    [
      "32.47 at 0 % + 89.92 at 7 % + 102.48 at 19 %, fixed 9.99",
      [at("32.47", "0"), at("89.92", "7"), at("102.48", "19")],
      amount("9.99"),
      "214.88",
      "24.62",
      "239.50",
    ],
    [
      "100 at 19 % + 100 at 7 %, 10 %",
      [at("100", "19"), at("100", "7")],
      percent("10"),
      "180.00",
      "23.40",
      "203.40",
    ],
    [
      "100 at 19 % + 100 at 7 %, fixed 10",
      [at("100", "19"), at("100", "7")],
      amount("10"),
      "190.00",
      "24.70",
      "214.70",
    ],
  ] as const)("gives the recorded sums for %s", (_label, positions, discount, net, tax, gross) => {
    expect(createTotals(positions, "net", discount)).toEqual({
      expected: { net, tax, gross },
      gross,
      warning: undefined,
    });
  });

  it("gives the recorded sums for a percentage on gross prices with two rates", () => {
    // Recorded 2026-11-18: 119.00 at 19 % + 107.00 at 7 % (gross), 10 %: 180, 23.4, 203.4.
    expect(createTotals([at("119", "19"), at("107", "7")], "gross", ten).expected).toEqual({
      net: "180.00",
      tax: "23.40",
      gross: "203.40",
    });
  });

  it.each([
    // Recorded 2026-11-18 (D-116): the gross total less the amount, exactly.
    ["119.00 at 19 %, fixed 10", [at("119", "19")], "10", "109.00"],
    ["119.00 at 19 % + 107.00 at 7 %, fixed 10", [at("119", "19"), at("107", "7")], "10", "216.00"],
    [
      "83.30 at 19 % + 32.10 at 7 %, fixed 9.99",
      [at("83.30", "19"), at("32.10", "7")],
      "9.99",
      "105.41",
    ],
  ] as const)(
    "takes a fixed amount on gross prices off the gross total and leaves net and tax to sevDesk: %s",
    (_label, positions, value, gross) => {
      const totals = createTotals(positions, "gross", amount(value));
      expect(totals).toEqual({
        expected: undefined,
        gross,
        warning:
          `On gross prices a fixed discount comes off the gross total (expected gross ${gross}); ` +
          "sevDesk splits it into net and tax in a way this server does not compute. Check net " +
          "and tax in the result before finalizing.",
      });
      expect(expectedOfCreate(totals)).toEqual({ gross });
    },
  );

  it("rounds each rate's share half-up and gives the cent left over to the rate with the largest net", () => {
    // 10.00 over 50.00 at each of three rates: 3.33 each, the cent left over to the first of
    // equals (the recorded cases put it on the largest net; equal nets are not recorded).
    expect(
      discountedTotals(
        [rate("19", "50", "59.5"), rate("7", "50", "53.5"), rate("0", "50", "50")],
        "net",
        amount("10"),
      ),
    ).toEqual({
      kind: "computed",
      // 19 %: (50 − 3.34) × 0.19 = 8.8654 → 8.87; 7 %: 46.67 × 0.07 = 3.2669 → 3.27.
      amounts: { net: "140.00", tax: "12.14", gross: "152.14" },
    });
    expect(discountedTotals([rate("19", "33.33", "39.66")], "net", percent("3"))).toEqual({
      kind: "computed",
      amounts: { net: "32.33", tax: "6.14", gross: "38.47" },
    });
    expect(discountedTotals([rate("0", "100", "100")], "net", ten)).toEqual({
      kind: "computed",
      amounts: { net: "90.00", tax: "0.00", gross: "90.00" },
    });
  });

  it("refuses an amount above the total and a total that is not positive", () => {
    expect(
      refusal(() => discountedTotals([rate("19", "100", "119")], "net", amount("100.01"))).message,
    ).toBe("The discount of 100.01 is more than the net total of 100.00.");
    expect(
      refusal(() => discountedTotals([rate("19", "100", "119")], "gross", amount("119.01")))
        .message,
    ).toBe("The discount of 119.01 is more than the gross total of 119.00.");
    expect(
      refusal(() => discountedTotals([rate("19", "-5", "-5.95")], "net", ten)).message,
    ).toContain("needs a positive total");
    expect(refusal(() => createTotals([at("50", "19"), at("-50", "7")], "net", ten)).message).toBe(
      "The net total is 0.00; a discount on the whole document needs a positive total.",
    );
  });

  it("allows one rate given twice", () => {
    expect(createTotals([recordedPosition, at("100", "19.00")], "net", ten).expected).toEqual({
      net: "180.00",
      tax: "34.20",
      gross: "214.20",
    });
  });

  it("leaves optional order positions out of the rates and the total", () => {
    expect(
      createTotals(
        [recordedPosition, { ...recordedPosition, taxRate: "7", optional: true }],
        "net",
        ten,
      ).expected,
    ).toEqual({ net: "90.00", tax: "17.10", gross: "107.10" });
  });

  it("sums the positions of one rate before splitting", () => {
    const totals = rateTotals([at("40", "19"), at("10", "7"), at("60", "19.0")], "net");
    expect(totals.map((item) => [item.rate, format(item.net, 2), format(item.gross, 2)])).toEqual([
      ["19", "100.00", "119.00"],
      ["7", "10.00", "10.70"],
    ]);
  });
});

describe("what an update does with the discount", () => {
  it("keeps the stored discount when the argument is left out", () => {
    const change = planDiscountChange(undefined, stored(row()), "Invoice 2102");
    expect(change).toEqual({
      body: {},
      changed: false,
      planned: undefined,
      after: { kind: "one", discount: { percentage: true, value: "10", text: "Rabatt" } },
    });
  });

  it("replaces every stored row with the new one", () => {
    const change = planDiscountChange({ amount: "25" }, stored(row()), "Invoice 2102");
    expect(change.body).toEqual({
      discountSave: [createDiscountBody({ ...fixed, value: "25" }).discountSave?.[0]],
      discountDelete: [{ id: 9001, objectName: "Discounts" }],
    });
    expect(change.planned).toEqual({ ...fixed, value: "25" });
  });

  it("adds a discount to a draft without one", () => {
    expect(planDiscountChange({ percent: "3" }, stored(), "Order 3102").body).toEqual({
      ...createDiscountBody({ ...ten, value: "3" }),
    });
  });

  it("removes the stored discount as recorded (discountSave null)", () => {
    expect(planDiscountChange(null, stored(row()), "Credit note 2202")).toMatchObject({
      body: { discountSave: null, discountDelete: [{ id: 9001, objectName: "Discounts" }] },
      planned: null,
      after: { kind: "none" },
    });
  });

  it("refuses to remove a discount that is not there, and to change several", () => {
    expect(refusal(() => planDiscountChange(null, stored(), "Invoice 2102")).message).toBe(
      "Invoice 2102 has no discount on the whole document to remove.",
    );
    // Several rows: sevDesk's sums counted only the newer one (checked 2026-11-17), so neither a
    // replacement nor a removal is offered; the refusal says why.
    const several = stored(row(), row({ id: 9002 }));
    const message =
      "Invoice 2102 has 2 discounts on the whole document, and sevDesk's totals do not count " +
      "all of them (in a check, only the newest). This tool changes a single discount: correct " +
      "them in sevDesk.";
    expect(refusal(() => planDiscountChange(null, several, "Invoice 2102")).message).toBe(message);
    expect(
      refusal(() => planDiscountChange({ percent: "3" }, several, "Invoice 2102")).message,
    ).toBe(message);
    // Keeping them is fine.
    expect(planDiscountChange(undefined, several, "Invoice 2102").after).toEqual({
      kind: "other",
    });
  });

  it.each([
    // Recorded 2026-11-18 on one rate only (net 100.00 + 10: 110, 20.9, 130.9); not computed.
    ["a surcharge", row({ surcharge: true })],
    ["a fixed surcharge", row({ surcharge: true, percentage: false })],
    // Not recorded.
    ["a percentage stored as gross", row({ isNet: false })],
  ])("treats %s as something it does not compute", (_label, stored) => {
    expect(storedDiscountState([stored])).toEqual({ kind: "other" });
  });

  it("computes with a fixed amount whatever its isNet (recorded 2026-11-18)", () => {
    // Net prices, a fixed 10.00 stored with isNet "0": 90, 17.1, 107.1, as with isNet "1".
    expect(storedDiscountState([row({ percentage: false, isNet: false })])).toEqual({
      kind: "one",
      discount: { percentage: false, value: "10", text: "Rabatt" },
    });
  });
});

describe("the totals of an update", () => {
  /** Draft 2102 as stored: 100.00 net at 19 % with 10 % off (the recorded sums). */
  const discountedDraft = {
    currency: "EUR",
    sumNet: "90",
    sumTax: "17.1",
    sumGross: "107.1",
    sumDiscountNet: "-10",
    sumDiscountGross: "-11.9",
  };
  const plainDraft = { currency: "EUR", sumNet: "100", sumTax: "19", sumGross: "119" };
  const storedPositions = [{ taxRate: "19" }];
  const totals = (
    change: DiscountChange,
    stored: typeof plainDraft,
    overrides: Partial<Parameters<typeof updateTotals>[0]> = {},
  ) =>
    updateTotals({
      change,
      positions: undefined,
      storedPositions,
      mode: "net",
      currencyChanged: false,
      stored,
      ...overrides,
    });

  it("leaves the totals alone when neither positions nor the discount change", () => {
    const keep = planDiscountChange(undefined, stored(row()), "Invoice 2102");
    expect(totals(keep, discountedDraft)).toEqual({
      expected: undefined,
      changes: false,
      warning: undefined,
    });
  });

  it("computes a new discount on the stored positions from the stored sums", () => {
    const add = planDiscountChange({ percent: "10" }, stored(), "Invoice 2102");
    expect(totals(add, plainDraft).expected).toEqual({
      net: "90.00",
      tax: "17.10",
      gross: "107.10",
    });
    const replace = planDiscountChange({ amount: "20" }, stored(row()), "Invoice 2102");
    expect(totals(replace, discountedDraft).expected).toEqual({
      net: "80.00",
      tax: "15.20",
      gross: "95.20",
    });
  });

  it("expects the undiscounted sums after a removal", () => {
    const remove = planDiscountChange(null, stored(row()), "Invoice 2102");
    expect(totals(remove, discountedDraft).expected).toEqual({
      net: "100.00",
      tax: "19.00",
      gross: "119.00",
    });
  });

  it("applies a kept discount to new positions", () => {
    const keep = planDiscountChange(undefined, stored(row()), "Invoice 2102");
    expect(
      totals(keep, discountedDraft, {
        positions: [{ ...recordedPosition, unitPrice: "200" }],
      }).expected,
    ).toEqual({ net: "180.00", tax: "34.20", gross: "214.20" });
  });

  it("never refuses a kept discount that no longer fits the new positions", () => {
    // Review of #114, finding 1: new positions that bring the net total to zero, or below a kept
    // fixed amount, must not refuse an update that leaves the discount alone.
    const keepFixed = planDiscountChange(
      undefined,
      stored(row({ percentage: false, value: "50" })),
      "Invoice 2102",
    );
    const below = totals(keepFixed, discountedDraft, {
      positions: [{ ...recordedPosition, unitPrice: "40" }],
    });
    expect(below).toEqual({
      expected: undefined,
      changes: true,
      warning:
        "The draft keeps its discount on the whole document. The discount of 50.00 is more than " +
        "the net total of 40.00. sevDesk computes the new total; check it in the result before " +
        "finalizing.",
    });

    const keepPercent = planDiscountChange(undefined, stored(row()), "Invoice 2102");
    const zero = totals(keepPercent, discountedDraft, {
      positions: [{ ...recordedPosition, unitPrice: "0" }],
    });
    expect(zero.expected).toBeUndefined();
    expect(zero.warning).toBe(
      "The draft keeps its discount on the whole document. The net total is 0.00; a discount on " +
        "the whole document needs a positive total. sevDesk computes the new total; check it in " +
        "the result before finalizing.",
    );
  });

  it("still refuses a new discount that does not fit the new positions", () => {
    const replace = planDiscountChange({ amount: "50" }, stored(row()), "Invoice 2102");
    expect(
      refusal(() =>
        totals(replace, discountedDraft, {
          positions: [{ ...recordedPosition, unitPrice: "40" }],
        }),
      ).message,
    ).toBe("The discount of 50.00 is more than the net total of 40.00.");
  });

  it("leaves the total to sevDesk, with a warning, for a kept discount it cannot compute", () => {
    const keep = planDiscountChange(undefined, stored(row(), row({ id: 9002 })), "Invoice 2102");
    const result = totals(keep, discountedDraft, { positions: [recordedPosition] });
    expect(result.expected).toBeUndefined();
    expect(result.changes).toBe(true);
    expect(result.warning).toMatch(/^The draft keeps its discounts on the whole document/);

    // A kept surcharge (D-116: recorded on one rate only) stays sevDesk's.
    const surcharge = planDiscountChange(
      undefined,
      stored(row({ surcharge: true })),
      "Invoice 2102",
    );
    const added = totals(surcharge, discountedDraft, { positions: [recordedPosition] });
    expect(added.expected).toBeUndefined();
    expect(added.warning).toContain("a surcharge");

    // A kept fixed amount on gross prices: off the gross total, split by sevDesk (D-116).
    const keepFixed = planDiscountChange(
      undefined,
      stored(row({ percentage: false })),
      "Invoice 2102",
    );
    const gross = totals(keepFixed, discountedDraft, {
      mode: "gross",
      positions: [{ ...recordedPosition, unitPrice: "119" }],
    });
    expect(gross).toEqual({
      expected: undefined,
      changes: true,
      warning:
        "The draft keeps its discount on the whole document. On gross prices a fixed discount " +
        "comes off the gross total (expected gross 109.00); sevDesk splits it into net and tax " +
        "in a way this server does not compute. sevDesk computes the new total; check it in the " +
        "result before finalizing.",
    });
  });

  it("computes a kept discount over the new positions' tax rates (recorded 2026-11-18)", () => {
    const single = planDiscountChange(undefined, stored(row()), "Invoice 2102");
    expect(
      totals(single, discountedDraft, {
        positions: [recordedPosition, { ...recordedPosition, taxRate: "7" }],
      }).expected,
    ).toEqual({ net: "180.00", tax: "23.40", gross: "203.40" });
  });

  it("computes a new discount over new positions with several rates", () => {
    const add = planDiscountChange({ amount: "9.99" }, stored(), "Invoice 2102");
    expect(
      totals(add, plainDraft, { positions: [at("70", "19"), at("30", "7")] }).expected,
    ).toEqual({ net: "90.01", tax: "13.86", gross: "103.87" });
  });

  it("computes a kept percentage on new gross positions (recorded 2026-11-18)", () => {
    const keep = planDiscountChange(undefined, stored(row()), "Invoice 2102");
    expect(
      totals(keep, discountedDraft, {
        mode: "gross",
        positions: [{ ...recordedPosition, unitPrice: "119" }],
      }).expected,
    ).toEqual({ net: "90.00", tax: "17.10", gross: "107.10" });
  });

  it("leaves a new discount on stored positions with several rates to sevDesk", () => {
    // The stored sums do not show the net per rate, which the split needs.
    const add = planDiscountChange({ percent: "10" }, stored(), "Invoice 2102");
    expect(
      totals(add, plainDraft, { storedPositions: [{ taxRate: "19" }, { taxRate: "7" }] }),
    ).toEqual({
      expected: undefined,
      changes: true,
      warning:
        "The stored positions have several tax rates, and the stored sums do not show the net " +
        "of each, which the split of the discount needs. sevDesk computes the new total; check " +
        "it in the result before finalizing.",
    });
    // An amount the stored total cannot take is still refused.
    const tooMuch = planDiscountChange({ amount: "100.01" }, stored(), "Invoice 2102");
    expect(
      refusal(() =>
        totals(tooMuch, plainDraft, { storedPositions: [{ taxRate: "19" }, { taxRate: "7" }] }),
      ).message,
    ).toBe("The discount of 100.01 is more than the net total of 100.00.");
  });

  it("leaves a discount on stored positions without a tax rate to sevDesk, not at 0 %", () => {
    // Review of #161: the rule takes the tax of the rest at the rate, so a missing rate read as
    // 0 % would expect 90.00 / 0.00 / 90.00 for a draft that carries 19 %.
    const add = planDiscountChange({ percent: "10" }, stored(), "Invoice 2102");
    expect(totals(add, plainDraft, { storedPositions: [{}] })).toEqual({
      expected: undefined,
      changes: true,
      warning:
        "sevDesk sent no tax rate for the stored positions, which the tax of the new total " +
        "needs. sevDesk computes the new total; check it in the result before finalizing.",
    });
    // A replacement of the stored discount the same way.
    const replace = planDiscountChange({ amount: "20" }, stored(row()), "Invoice 2102");
    expect(
      totals(replace, discountedDraft, { storedPositions: [{ taxRate: undefined }] }).expected,
    ).toBeUndefined();
  });

  it("leaves a new fixed amount on stored gross positions to sevDesk, with the gross total", () => {
    const add = planDiscountChange({ amount: "10" }, stored(), "Invoice 2102");
    expect(totals(add, plainDraft, { mode: "gross" }).warning).toBe(
      "On gross prices a fixed discount comes off the gross total (expected gross 109.00); " +
        "sevDesk splits it into net and tax in a way this server does not compute. sevDesk " +
        "computes the new total; check it in the result before finalizing.",
    );
  });

  it("does not compute a new discount on stored sums in a new currency", () => {
    const add = planDiscountChange({ percent: "10" }, stored(), "Invoice 2102");
    const result = totals(add, plainDraft, { currencyChanged: true });
    expect(result.expected).toBeUndefined();
    expect(result.warning).toContain("cannot be read in the new currency");
  });
});

describe("preview and read-back", () => {
  it("names the discount and the stored rows", () => {
    expect(discountText(ten, "EUR", "net")).toBe('10 % of the net total ("Rabatt")');
    expect(discountText({ ...fixed, value: "50" }, "EUR", "net")).toBe('50.00 EUR net ("Rabatt")');
    // On gross prices the amount argument is a gross amount (D-116, recorded 2026-11-18).
    expect(discountText({ ...fixed, value: "50" }, "EUR", "gross")).toBe(
      '50.00 EUR gross ("Rabatt")',
    );
    expect(discountText(ten, "EUR", "gross")).toBe('10 % of the net total ("Rabatt")');
    expect(
      storedDiscountText(
        [row(), row({ id: 2, surcharge: true, percentage: false, isNet: false, text: undefined })],
        "EUR",
        "net",
      ),
      // A fixed amount follows the price mode, not isNet (D-116, recorded 2026-11-18).
    ).toBe('10 % of the net total ("Rabatt"); surcharge (Aufschlag): 10.00 EUR net');
    expect(storedDiscountText([], "EUR", "net")).toBeUndefined();
  });

  it("writes a stored and a new fixed amount alike, in the document's currency", () => {
    // Review of #114, finding 2: the stored row was "10 EUR net", the new one "10.00 EUR net".
    // sevDesk reads a fixed amount in the document's currency (D-116, recorded 2026-11-18).
    const stored = row({ percentage: false, value: "10" });
    expect(storedDiscountText([stored], "EUR", "net")).toBe('10.00 EUR net ("Rabatt")');
    expect(discountText({ ...fixed, value: "10" }, "EUR", "net")).toBe('10.00 EUR net ("Rabatt")');
    expect(storedDiscountText([stored], "CHF", "net")).toBe('10.00 CHF net ("Rabatt")');
    expect(storedDiscountText([row({ percentage: false, value: "12.345" })], "EUR", "net")).toBe(
      '12.345 EUR net ("Rabatt")',
    );
  });

  it("shows a stored fixed amount on gross prices as gross, whatever isNet says (D-116)", () => {
    // Recorded 2026-11-18: on a gross document a fixed 10.00 came off the gross total with isNet
    // "1" and "0" alike; a percentage keeps its stored basis.
    const fixedRow = row({ percentage: false, value: "10" });
    expect(storedDiscountText([fixedRow], "EUR", "gross")).toBe('10.00 EUR gross ("Rabatt")');
    expect(storedDiscountText([row()], "EUR", "gross")).toBe('10 % of the net total ("Rabatt")');
    // And on net prices it comes off the net total with isNet "0" too (recorded 2026-11-18).
    expect(storedDiscountText([row({ percentage: false, isNet: false })], "EUR", "net")).toBe(
      '10.00 EUR net ("Rabatt")',
    );
  });

  const item = { id: 9001, kind: "percent" as const, value: "10", basis: "net" as const };

  it("says nothing when sevDesk stored what was sent", () => {
    expect(discountReadBackNote(ten, { items: [item] }, "invoice")).toBeUndefined();
    expect(discountReadBackNote(null, undefined, "invoice")).toBeUndefined();
    expect(discountReadBackNote(undefined, { items: [item, item] }, "invoice")).toBeUndefined();
  });

  it("says so when sevDesk stored something else", () => {
    expect(discountReadBackNote(ten, { items: [item, { ...item, id: 9002 }] }, "invoice")).toBe(
      "sevDesk lists 2 discount(s) on the whole invoice, not the one this call sent; check them " +
        "in sevDesk before finalizing.",
    );
    expect(discountReadBackNote(fixed, { items: [item] }, "order")).toContain("not the one");
    expect(discountReadBackNote(null, { items: [item] }, "credit note")).toBe(
      "sevDesk still lists 1 discount(s) on the whole credit note; check them in sevDesk before " +
        "finalizing.",
    );
  });
});
