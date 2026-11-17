/**
 * The document discount of the draft tools (spec/deviations.md D-116, recorded 2026-11-16): the
 * argument, the body keys in the recorded form, the totals with the discount, the change an update
 * makes, and the refusals of what is not recorded.
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
  planDiscountChange,
  resolveDiscount,
  storedDiscountState,
  storedDiscountText,
  updateTotals,
} from "../../../../src/domain/drafts/discount.js";
import { saveInvoiceBodySchema, strictBody } from "../../../../src/domain/drafts/payloads.js";
import type { DraftPosition } from "../../../../src/domain/drafts/positions.js";
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

describe("totals with the discount", () => {
  it("gives the recorded sums for 10 % and for a fixed 10.00 on 100.00 at 19 %", () => {
    const recorded = { net: "90.00", tax: "17.10", gross: "107.10" };
    expect(createTotals([recordedPosition], "net", ten, "EUR")).toEqual(recorded);
    expect(createTotals([recordedPosition], "net", fixed, "EUR")).toEqual(recorded);
  });

  it("rounds the deduction and its tax to cents, exactly", () => {
    expect(
      discountedTotals({ net: "33.33", tax: "6.33", gross: "39.66" }, "19", {
        ...ten,
        value: "3",
      }),
    ).toEqual({ net: "32.33", tax: "6.14", gross: "38.47" });
    expect(discountedTotals({ net: "100.00", tax: "0.00", gross: "100.00" }, "0", ten)).toEqual({
      net: "90.00",
      tax: "0.00",
      gross: "90.00",
    });
  });

  it("refuses a fixed amount above the net total and a total that is not positive", () => {
    expect(
      refusal(() =>
        discountedTotals({ net: "100.00", tax: "19.00", gross: "119.00" }, "19", {
          ...fixed,
          value: "100.01",
        }),
      ).message,
    ).toBe("The discount of 100.01 is more than the net total of 100.00.");
    expect(
      refusal(() => discountedTotals({ net: "-5.00", tax: "-0.95", gross: "-5.95" }, "19", ten))
        .message,
    ).toContain("needs a positive total");
  });

  it.each([
    ["gross prices", "gross", [recordedPosition], ten, "EUR", "only verified for net prices"],
    [
      "several tax rates",
      "net",
      [recordedPosition, { ...recordedPosition, taxRate: "7" }],
      ten,
      "EUR",
      "one tax rate",
    ],
    [
      "a fixed amount in CHF",
      "net",
      [recordedPosition],
      fixed,
      "CHF",
      "give the discount in percent",
    ],
  ] as const)(
    "refuses a new discount on %s (not recorded)",
    (_label, mode, positions, discount, currency, message) => {
      const error = refusal(() => createTotals(positions, mode, discount, currency));
      expect(error.kind).toBe("validation");
      expect(error.message).toContain(message);
    },
  );

  it("allows a percentage in another currency and one rate given twice", () => {
    expect(
      createTotals(
        [recordedPosition, { ...recordedPosition, taxRate: "19.00" }],
        "net",
        ten,
        "CHF",
      ),
    ).toEqual({ net: "180.00", tax: "34.20", gross: "214.20" });
  });

  it("leaves optional order positions out of the rates and the total", () => {
    expect(
      createTotals(
        [recordedPosition, { ...recordedPosition, taxRate: "7", optional: true }],
        "net",
        ten,
        "EUR",
      ),
    ).toEqual({ net: "90.00", tax: "17.10", gross: "107.10" });
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
    ["a surcharge", row({ surcharge: true })],
    ["a gross amount", row({ percentage: false, isNet: false })],
  ])("treats %s as something it does not compute", (_label, stored) => {
    expect(storedDiscountState([stored])).toEqual({ kind: "other" });
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
      currency: "EUR",
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

    const single = planDiscountChange(undefined, stored(row()), "Invoice 2102");
    const mixed = totals(single, discountedDraft, {
      positions: [recordedPosition, { ...recordedPosition, taxRate: "7" }],
    });
    expect(mixed.expected).toBeUndefined();
    expect(mixed.warning).toContain("only verified for positions with one tax rate");
  });

  it("refuses a new discount on stored positions with several rates and on an e-invoice", () => {
    const add = planDiscountChange({ percent: "10" }, stored(), "Invoice 2102");
    expect(
      refusal(() =>
        totals(add, plainDraft, {
          storedPositions: [{ taxRate: "19" }, { taxRate: "7" }],
        }),
      ).message,
    ).toContain("one tax rate");
    expect(refusal(() => totals(add, plainDraft, { eInvoice: true })).message).toContain(
      "e-invoice (XRechnung/ZUGFeRD)",
    );
  });

  it("does not compute a new discount on stored sums in a new currency", () => {
    const add = planDiscountChange({ percent: "10" }, stored(), "Invoice 2102");
    const result = totals(add, plainDraft, { currency: "CHF", currencyChanged: true });
    expect(result.expected).toBeUndefined();
    expect(result.warning).toContain("cannot be read in the new currency");
  });
});

describe("preview and read-back", () => {
  it("names the discount and the stored rows", () => {
    expect(discountText(ten, "EUR")).toBe('10 % of the net total ("Rabatt")');
    expect(discountText({ ...fixed, value: "50" }, "EUR")).toBe('50.00 EUR net ("Rabatt")');
    expect(
      storedDiscountText(
        [row(), row({ id: 2, surcharge: true, percentage: false, isNet: false, text: undefined })],
        "EUR",
      ),
    ).toBe('10 % of the net total ("Rabatt"); surcharge (Aufschlag): 10.00 EUR gross');
    expect(storedDiscountText([], "EUR")).toBeUndefined();
  });

  it("writes a stored and a new fixed amount alike, and names no currency outside EUR", () => {
    // Review of #114, finding 2: the stored row was "10 EUR net", the new one "10.00 EUR net",
    // and a CHF draft's stored fixed amount was given a currency the approval leaves out (D-116).
    const stored = row({ percentage: false, value: "10" });
    expect(storedDiscountText([stored], "EUR")).toBe('10.00 EUR net ("Rabatt")');
    expect(discountText({ ...fixed, value: "10" }, "EUR")).toBe('10.00 EUR net ("Rabatt")');
    expect(storedDiscountText([stored], "CHF")).toBe('10.00 net (fixed amount) ("Rabatt")');
    expect(storedDiscountText([row({ percentage: false, value: "12.345" })], "EUR")).toBe(
      '12.345 EUR net ("Rabatt")',
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
