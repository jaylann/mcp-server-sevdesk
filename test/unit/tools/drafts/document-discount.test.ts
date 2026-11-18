/**
 * The `discount` argument of the invoice, order and credit note draft tools (spec/deviations.md
 * D-116, recorded 2026-11-16): create sends `discountSave` as a list of one; update keeps the
 * stored discount, replaces it (the stored rows in `discountDelete`) or removes it (`null`), after
 * reading the stored rows with `getDiscounts`; the preview and the expected totals include it; the
 * read-back shows it and says when sevDesk stored something else. The replacement in one request
 * and an addition with `invoicePosSave: null` were checked live on 2026-11-17.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { creditNoteCreateDraftTool } from "../../../../src/tools/credit-notes/draft-create.js";
import { creditNoteUpdateDraftTool } from "../../../../src/tools/credit-notes/draft-update.js";
import { invoiceCreateDraftTool } from "../../../../src/tools/invoices/draft-create.js";
import { invoiceUpdateDraftTool } from "../../../../src/tools/invoices/draft-update.js";
import { orderCreateDraftTool } from "../../../../src/tools/orders/draft-create.js";
import { orderUpdateDraftTool } from "../../../../src/tools/orders/draft-update.js";
import type { AnyWriteToolDefinition } from "../../../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  creditNoteCreateArgs,
  creditNoteCreateRoutes,
  creditNoteUpdateRoutes,
  discountRow,
  discountsRoute,
  invoiceCreateArgs,
  invoiceCreateRoutes,
  invoiceUpdateRoutes,
  orderCreateArgs,
  orderCreateRoutes,
  orderUpdateRoutes,
  withRoutes,
} from "./routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

type Row = Record<string, unknown>;

/** The record of `fixture` (one object) with `fields` replaced, answered on `path`. */
function record(path: string, fixture: string, fields: Row, query?: FakeRoute["query"]): FakeRoute {
  const stored = loadFixture(fixture).body as { objects: Row[] };
  return {
    path,
    ...(query === undefined ? {} : { query }),
    response: { body: { objects: [{ ...stored.objects[0], ...fields }] } },
  };
}

function bodyOf(client: FakeSevdeskClient): Row {
  const write = client.writes().find((call) => call.method === "POST");
  return write?.body as Row;
}

async function refusal(
  tool: AnyWriteToolDefinition,
  args: unknown,
  routes: readonly FakeRoute[],
): Promise<SevdeskError> {
  const client = new FakeSevdeskClient(routes);
  const error = await prepareWrite(tool, args, client).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  expect(client.writes()).toEqual([]);
  return error as SevdeskError;
}

const savedTen = {
  objectName: "Discounts",
  mapAll: true,
  discount: true,
  text: "Rabatt",
  percentage: true,
  value: 10,
};

describe("create with a discount", () => {
  // 3 × 10.00 + 1 × 25.00 net at 19 %: 55.00 net, 10.45 tax; 10 % off is 5.50 net, and the tax
  // is that of the rest, 49.50 × 19 % = 9.405 → 9.41 (the rule recorded 2026-11-18, D-116; the
  // half-up at this tie is assumed, no recorded case lands on a half cent).
  const discounted = { net: "49.50", tax: "9.41", gross: "58.91" };

  it("sends the recorded keys after the positions, previews the discount and its total", async () => {
    const client = new FakeSevdeskClient(invoiceCreateRoutes);
    const plan = await prepareWrite(
      invoiceCreateDraftTool,
      { ...invoiceCreateArgs, discount: { percent: 10 } },
      client,
    );

    expect(client.writes()).toEqual([]);
    expect(plan.state.body).toMatchObject({
      invoicePosDelete: null,
      discountSave: [savedTen],
      discountDelete: null,
    });
    expect(Object.keys(plan.state.body).slice(-2)).toEqual(["discountSave", "discountDelete"]);
    // T0 (#110): an invoice body keeps its text invoiceType.
    expect(plan.state.body.invoice.invoiceType).toBe("RE");
    expect(plan.state.expected).toEqual(discounted);
    expect(plan.preview.facts).toContainEqual({
      label: "Discount",
      value: '10 % of the net total ("Rabatt")',
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Total (expected)",
      value: "net 49.50 EUR, tax 9.41 EUR, gross 58.91 EUR",
    });
    expect(plan.preview.action).toContain("gross 58.91 EUR");
    // The duplicate check looks for the discounted total.
    expect(plan.preview.warnings.join(" ")).not.toContain("65.45");
  });

  it("shows the stored discount after the save and says nothing when it matches", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(
        invoiceCreateRoutes,
        record(
          "/Invoice/2101",
          "drafts/invoice-2101.json",
          {
            sumNet: "49.5",
            sumTax: "9.41",
            sumGross: "58.91",
            sumDiscountNet: "-5.5",
            sumDiscountGross: "-6.54",
          },
          { embed: "contact" },
        ),
        discountsRoute("Invoice", 2101, [discountRow("Invoice", 2101)]),
      ),
    );
    const { output } = await executeWrite(
      invoiceCreateDraftTool,
      { ...invoiceCreateArgs, discount: { percent: 10 } },
      client,
    );

    expect(bodyOf(client)).toMatchObject({ discountSave: [savedTen], discountDelete: null });
    expect(output.data).toMatchObject({
      discount: {
        items: [{ id: 9001, kind: "percent", value: "10", basis: "net", text: "Rabatt" }],
        net: { amount: "-5.50", currency: "EUR" },
        gross: { amount: "-6.54", currency: "EUR" },
      },
    });
    expect(output.data["notes"]).not.toContainEqual(expect.stringContaining("discount"));
    expect(output.data["notes"]).not.toContainEqual(expect.stringContaining("gross total"));
  });

  it("notes a discount sevDesk did not store", async () => {
    const client = new FakeSevdeskClient(invoiceCreateRoutes);
    const { output } = await executeWrite(
      invoiceCreateDraftTool,
      { ...invoiceCreateArgs, discount: { amount: "5.50" } },
      client,
    );
    expect(output.data["notes"]).toContainEqual(
      "sevDesk lists 0 discount(s) on the whole invoice, not the one this call sent; check them " +
        "in sevDesk before finalizing.",
    );
  });

  it("does the same for orders and credit notes", async () => {
    const order = new FakeSevdeskClient(orderCreateRoutes);
    const orderPlan = await prepareWrite(
      orderCreateDraftTool,
      { ...orderCreateArgs, discount: { amount: 10, text: "Messerabatt" } },
      order,
    );
    expect(orderPlan.state.body).toMatchObject({
      orderPosDelete: null,
      discountSave: [{ ...savedTen, percentage: false, text: "Messerabatt" }],
      discountDelete: null,
    });
    expect(orderPlan.state.expected).toEqual({ net: "45.00", tax: "8.55", gross: "53.55" });

    const creditNote = new FakeSevdeskClient(creditNoteCreateRoutes);
    const creditPlan = await prepareWrite(
      creditNoteCreateDraftTool,
      { ...creditNoteCreateArgs, discount: { percent: "50" } },
      creditNote,
    );
    expect(creditPlan.state.body).toMatchObject({
      creditNotePosDelete: null,
      discountSave: [{ ...savedTen, value: 50 }],
      discountDelete: null,
    });
    expect(creditPlan.state.expected).toEqual({ net: "5.00", tax: "0.95", gross: "5.95" });
  });

  it("sends no discount keys without the argument (the shipped body)", async () => {
    const client = new FakeSevdeskClient(invoiceCreateRoutes);
    const plan = await prepareWrite(invoiceCreateDraftTool, invoiceCreateArgs, client);
    expect(plan.state.body).not.toHaveProperty("discountSave");
    expect(plan.state.body).not.toHaveProperty("discountDelete");
  });

  it("splits a discount over several tax rates (recorded 2026-11-18, D-116)", async () => {
    const plan = await prepareWrite(
      invoiceCreateDraftTool,
      {
        ...invoiceCreateArgs,
        positions: [
          { name: "A", quantity: 1, unitPrice: 70, taxRate: 19 },
          { name: "B", quantity: 1, unitPrice: 30, taxRate: 7 },
        ],
        discount: { amount: "9.99" },
      },
      new FakeSevdeskClient(invoiceCreateRoutes),
    );
    expect(plan.state.body).toMatchObject({
      discountSave: [{ ...savedTen, percentage: false, value: 9.99 }],
    });
    // Recorded: 90.01, 13.86, 103.87.
    expect(plan.state.expected).toEqual({ net: "90.01", tax: "13.86", gross: "103.87" });
    expect(plan.preview.warnings.join(" ")).not.toContain("does not compute");
  });

  it("takes a fixed amount on gross prices as gross and leaves net and tax to sevDesk", async () => {
    // Recorded 2026-11-18 (D-116): a fixed amount comes off the gross total exactly; how sevDesk
    // splits it into net and tax is not reproduced here.
    const client = new FakeSevdeskClient(invoiceCreateRoutes);
    const plan = await prepareWrite(
      invoiceCreateDraftTool,
      { ...invoiceCreateArgs, priceMode: "gross", discount: { amount: 5 } },
      client,
    );
    expect(client.writes()).toEqual([]);
    expect(plan.state.body).toMatchObject({
      invoice: { showNet: false },
      discountSave: [{ ...savedTen, percentage: false, value: 5 }],
    });
    // 3 × 10.00 + 25.00 gross, less 5.00.
    expect(plan.state.expected).toEqual({ gross: "50.00" });
    expect(plan.preview.facts).toContainEqual({
      label: "Discount",
      value: '5.00 EUR gross ("Rabatt")',
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Total (expected)",
      value: "gross 50.00 EUR; net and tax as sevDesk splits them",
    });
    expect(plan.preview.action).toContain("gross 50.00 EUR");
    expect(plan.preview.warnings).toContainEqual(
      "On gross prices a fixed discount comes off the gross total (expected gross 50.00); " +
        "sevDesk splits it into net and tax in a way this server does not compute. Check net " +
        "and tax in the result before finalizing.",
    );
  });

  it.each([
    ["more than the net total", { discount: { amount: "55.01" } }, "more than the net total"],
    [
      "more than the gross total on gross prices",
      { priceMode: "gross", discount: { amount: "55.01" } },
      "The discount of 55.01 is more than the gross total of 55.00.",
    ],
    ["percent and amount", { discount: { percent: 3, amount: 5 } }, "not both"],
  ])("refuses a discount on %s before anything is written", async (_label, extra, message) => {
    const error = await refusal(
      invoiceCreateDraftTool,
      { ...invoiceCreateArgs, ...extra },
      invoiceCreateRoutes,
    );
    expect(error.message).toContain(message);
  });

  it("takes a percentage on gross prices and a fixed amount in USD (recorded 2026-11-18)", async () => {
    // A percentage on gross prices gives the same totals as on net prices; a fixed amount is in
    // the document's currency (D-116).
    const gross = await prepareWrite(
      invoiceCreateDraftTool,
      { ...invoiceCreateArgs, priceMode: "gross", discount: { percent: 10 } },
      new FakeSevdeskClient(invoiceCreateRoutes),
    );
    expect(gross.state.body).toMatchObject({ discountSave: [savedTen], discountDelete: null });
    expect(gross.preview.facts).toContainEqual({
      label: "Discount",
      value: '10 % of the net total ("Rabatt")',
    });

    const usd = await prepareWrite(
      invoiceCreateDraftTool,
      { ...invoiceCreateArgs, currency: "USD", discount: { amount: "5.50" } },
      new FakeSevdeskClient(invoiceCreateRoutes),
    );
    expect(usd.state.body).toMatchObject({
      discountSave: [{ ...savedTen, percentage: false, value: 5.5 }],
    });
    expect(usd.state.expected).toEqual(discounted);
    expect(usd.preview.facts).toContainEqual({
      label: "Discount",
      value: '5.50 USD net ("Rabatt")',
    });
  });
});

describe("update: keep, replace, remove", () => {
  /** Order 3102 as stored: one position of 200.00 net at 19 %. */
  const orderArgs = { id: 3102 };

  it("reads the stored discounts first and keeps them when the argument is left out", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(orderUpdateRoutes, discountsRoute("Order", 3102, [discountRow("Order", 3102)])),
    );
    const plan = await prepareWrite(orderUpdateDraftTool, { ...orderArgs, header: "Neu" }, client);

    expect(client.callsTo("/Order/3102/getDiscounts")).toHaveLength(1);
    expect(plan.state.body).not.toHaveProperty("discountSave");
    expect(plan.state.body).not.toHaveProperty("discountDelete");
    expect(plan.preview.facts).toContainEqual({
      label: "Discount (unchanged)",
      value: '10 % of the net total ("Rabatt")',
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Total (unchanged)",
      value: "gross 238.00 EUR",
    });
  });

  it("replaces the stored discount: deletes its row and saves the new one in one request", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(orderUpdateRoutes, discountsRoute("Order", 3102, [discountRow("Order", 3102)])),
    );
    await executeWrite(orderUpdateDraftTool, { ...orderArgs, discount: { amount: 20 } }, client);

    expect(bodyOf(client)).toMatchObject({
      orderPosSave: null,
      orderPosDelete: null,
      discountSave: [{ ...savedTen, percentage: false, value: 20 }],
      discountDelete: [{ id: 9001, objectName: "Discounts" }],
    });
  });

  it("adds a discount to a draft without one and expects the total from the stored sums", async () => {
    const client = new FakeSevdeskClient(orderUpdateRoutes);
    const plan = await prepareWrite(
      orderUpdateDraftTool,
      { ...orderArgs, discount: { amount: 20 } },
      client,
    );
    expect(plan.state.body).toMatchObject({ discountDelete: null });
    expect(plan.state.expected).toEqual({ net: "180.00", tax: "34.20", gross: "214.20" });
    expect(plan.preview.facts).toContainEqual({
      label: "Discount",
      value: '(none) → 20.00 EUR net ("Rabatt")',
    });
    expect(plan.preview.action).toContain("change discount");
  });

  it("removes the stored discount with discount: null (the recorded removal)", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(
        creditNoteUpdateRoutes,
        discountsRoute("CreditNote", 2202, [discountRow("CreditNote", 2202, { id: "9005" })]),
        record("/CreditNote/2202", "drafts/credit-note-2202-draft.json", {
          sumNet: "36",
          sumTax: "6.84",
          sumGross: "42.84",
          sumDiscountNet: "-4",
          sumDiscountGross: "-4.76",
        }),
      ),
    );
    const plan = await prepareWrite(
      creditNoteUpdateDraftTool,
      { id: 2202, discount: null },
      client,
    );
    expect(plan.state.body).toMatchObject({
      creditNotePosSave: [],
      creditNotePosDelete: null,
      discountSave: null,
      discountDelete: [{ id: 9005, objectName: "Discounts" }],
    });
    // The stored sums without the stored discount.
    expect(plan.state.expected).toEqual({ net: "40.00", tax: "7.60", gross: "47.60" });
    expect(plan.preview.facts).toContainEqual({
      label: "Discount",
      value: '10 % of the net total ("Rabatt") → (none)',
    });
  });

  describe("on an invoice as checked live on 2026-11-17 (100.00 net at 19 %)", () => {
    /** Invoice 2102 with one position of 100.00 net at 19 % (its first stored row, repriced). */
    function onePosition(): FakeRoute {
      const stored = loadFixture("drafts/invoice-positions-2102.json").body as { objects: Row[] };
      return {
        path: "/InvoicePos",
        query: { "invoice[id]": 2102 },
        response: { body: { objects: [{ ...stored.objects[0], price: "100", sumNet: "100" }] } },
      };
    }

    function invoice(fields: Row, rows: readonly Row[]): FakeRoute[] {
      return withRoutes(
        invoiceUpdateRoutes,
        record("/Invoice/2102", "drafts/invoice-2102-draft.json", fields),
        onePosition(),
        discountsRoute("Invoice", 2102, rows),
      );
    }

    it("replaces the stored 10 % with a fixed 5.00 in one request: the checked body and sums", async () => {
      const client = new FakeSevdeskClient(
        invoice(
          {
            sumNet: "90",
            sumTax: "17.1",
            sumGross: "107.1",
            sumDiscountNet: "-10",
            sumDiscountGross: "-11.9",
          },
          [discountRow("Invoice", 2102)],
        ),
      );
      const plan = await prepareWrite(
        invoiceUpdateDraftTool,
        { id: 2102, discount: { amount: 5 } },
        client,
      );

      // The keys and their order as sent in the check; T0 (#110): invoiceType "RE".
      expect(Object.keys(plan.state.body)).toEqual([
        "invoice",
        "invoicePosSave",
        "invoicePosDelete",
        "discountSave",
        "discountDelete",
      ]);
      expect(plan.state.body).toMatchObject({
        invoice: { id: 2102, objectName: "Invoice", mapAll: true, invoiceType: "RE" },
        invoicePosSave: null,
        invoicePosDelete: null,
        discountSave: [{ ...savedTen, percentage: false, value: 5 }],
        discountDelete: [{ id: 9001, objectName: "Discounts" }],
      });
      // sevDesk's sums after the check: 95, 18.05, 113.05.
      expect(plan.state.expected).toEqual({ net: "95.00", tax: "18.05", gross: "113.05" });
    });

    it("adds 10 % with invoicePosSave null: the checked sums", async () => {
      const client = new FakeSevdeskClient(
        invoice({ sumNet: "100", sumTax: "19", sumGross: "119" }, []),
      );
      const plan = await prepareWrite(
        invoiceUpdateDraftTool,
        { id: 2102, discount: { percent: 10 } },
        client,
      );
      expect(plan.state.body).toMatchObject({
        invoicePosSave: null,
        discountSave: [savedTen],
        discountDelete: null,
      });
      expect(plan.state.expected).toEqual({ net: "90.00", tax: "17.10", gross: "107.10" });
    });
  });

  it("puts a new discount on new positions of an invoice (one rate)", async () => {
    const client = new FakeSevdeskClient(invoiceUpdateRoutes);
    const plan = await prepareWrite(
      invoiceUpdateDraftTool,
      {
        id: 2102,
        positions: [{ name: "Beratung", quantity: 1, unitPrice: 100, taxRate: 19 }],
        discount: { percent: 10 },
      },
      client,
    );
    expect(plan.state.body).toMatchObject({
      discountSave: [savedTen],
      discountDelete: null,
    });
    expect(plan.state.body.invoice.invoiceType).toBe("RE");
    expect(plan.state.expected).toEqual({ net: "90.00", tax: "17.10", gross: "107.10" });
  });

  it("keeps a stored discount on new positions and expects it in the total", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(
        invoiceUpdateRoutes,
        discountsRoute("Invoice", 2102, [discountRow("Invoice", 2102)]),
      ),
    );
    const plan = await prepareWrite(
      invoiceUpdateDraftTool,
      { id: 2102, positions: [{ name: "Beratung", quantity: 2, unitPrice: 50, taxRate: 19 }] },
      client,
    );
    expect(plan.state.body).not.toHaveProperty("discountSave");
    expect(plan.state.expected).toEqual({ net: "90.00", tax: "17.10", gross: "107.10" });
  });

  it("does not refuse new positions below a kept fixed discount: sevDesk computes the total", async () => {
    // Review of #114, finding 1: the call leaves the discount alone, so it is not refused.
    const client = new FakeSevdeskClient(
      withRoutes(
        invoiceUpdateRoutes,
        discountsRoute("Invoice", 2102, [
          discountRow("Invoice", 2102, { percentage: "0", value: "50" }),
        ]),
      ),
    );
    const plan = await prepareWrite(
      invoiceUpdateDraftTool,
      { id: 2102, positions: [{ name: "Beratung", quantity: 1, unitPrice: 40, taxRate: 19 }] },
      client,
    );
    expect(plan.state.body).not.toHaveProperty("discountSave");
    expect(plan.state.expected).toBeUndefined();
    expect(plan.preview.facts).toContainEqual({
      label: "Discount (unchanged)",
      value: '50.00 EUR net ("Rabatt")',
    });
    expect(plan.preview.warnings).toContain(
      "The draft keeps its discount on the whole document. The discount of 50.00 is more than " +
        "the net total of 40.00. sevDesk computes the new total; check it in the result before " +
        "finalizing.",
    );
  });

  it("warns and leaves the total to sevDesk for kept discounts it does not compute", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(
        invoiceUpdateRoutes,
        discountsRoute("Invoice", 2102, [
          discountRow("Invoice", 2102),
          discountRow("Invoice", 2102, { id: "9002", percentage: "0", value: "5" }),
        ]),
      ),
    );
    const plan = await prepareWrite(
      invoiceUpdateDraftTool,
      { id: 2102, positions: [{ name: "Beratung", quantity: 1, unitPrice: 100, taxRate: 19 }] },
      client,
    );
    expect(plan.state.expected).toBeUndefined();
    expect(plan.preview.facts).toContainEqual({
      label: "Total (before this change)",
      value: "gross 116.60 EUR",
    });
    expect(plan.preview.warnings.join(" ")).toContain(
      "The draft keeps its discounts on the whole document",
    );
    expect(plan.preview.warnings.join(" ")).toContain(
      "with several, sevDesk's totals may count only one of them",
    );
  });

  it("leaves a new discount on stored positions with several rates to sevDesk, with a warning", async () => {
    // Stored 19 % and 7 %: the stored sums do not show the net of each rate.
    const client = new FakeSevdeskClient(invoiceUpdateRoutes);
    const plan = await prepareWrite(
      invoiceUpdateDraftTool,
      { id: 2102, discount: { percent: 10 } },
      client,
    );
    expect(client.writes()).toEqual([]);
    expect(plan.state.body).toMatchObject({ discountSave: [savedTen] });
    expect(plan.state.expected).toBeUndefined();
    expect(plan.preview.warnings).toContainEqual(
      "The stored positions have several tax rates, and the stored sums do not show the net of " +
        "each, which the split of the discount needs. sevDesk computes the new total; check it " +
        "in the result before finalizing.",
    );
  });

  it.each([
    [
      "a draft with several discounts",
      { id: 2102, discount: null },
      withRoutes(
        invoiceUpdateRoutes,
        discountsRoute("Invoice", 2102, [
          discountRow("Invoice", 2102),
          discountRow("Invoice", 2102, { id: "9002" }),
        ]),
      ),
      // With several rows sevDesk's totals do not count all of them (checked 2026-11-17).
      "has 2 discounts on the whole document, and sevDesk's totals do not count all of them",
    ],
    [
      "removing a discount that is not there",
      { id: 2102, discount: null },
      invoiceUpdateRoutes,
      "has no discount on the whole document to remove",
    ],
  ])("refuses %s", async (_label, args, routes, message) => {
    const error = await refusal(invoiceUpdateDraftTool, args, routes);
    expect(error.message).toContain(message);
  });

  it("takes a discount on an e-invoice, which carries it as an allowance (recorded 2026-11-18)", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(
        invoiceUpdateRoutes,
        record("/Invoice/2102", "drafts/invoice-2102-draft.json", { propertyIsEInvoice: "1" }),
      ),
    );
    const plan = await prepareWrite(
      invoiceUpdateDraftTool,
      {
        id: 2102,
        positions: [{ name: "Beratung", quantity: 1, unitPrice: 100, taxRate: 19 }],
        discount: { percent: 10 },
      },
      client,
    );
    expect(plan.state.body).toMatchObject({ discountSave: [savedTen] });
    expect(plan.state.expected).toEqual({ net: "90.00", tax: "17.10", gross: "107.10" });
    expect(client.writes()).toEqual([]);
  });

  it("takes a fixed gross amount on a credit note with gross prices, net and tax by sevDesk", async () => {
    const client = new FakeSevdeskClient(creditNoteUpdateRoutes);
    const plan = await prepareWrite(
      creditNoteUpdateDraftTool,
      {
        id: 2202,
        priceMode: "gross",
        positions: [{ name: "Minderung", quantity: 1, unitPrice: 11.9, taxRate: 19 }],
        discount: { amount: 1 },
      },
      client,
    );
    expect(client.writes()).toEqual([]);
    expect(plan.state.expected).toBeUndefined();
    expect(plan.preview.warnings).toContainEqual(
      "On gross prices a fixed discount comes off the gross total (expected gross 10.90); " +
        "sevDesk splits it into net and tax in a way this server does not compute. sevDesk " +
        "computes the new total; check it in the result before finalizing.",
    );
    // More than the gross total is still refused.
    const error = await refusal(
      creditNoteUpdateDraftTool,
      {
        id: 2202,
        priceMode: "gross",
        positions: [{ name: "Minderung", quantity: 1, unitPrice: 11.9, taxRate: 19 }],
        discount: { amount: "11.91" },
      },
      creditNoteUpdateRoutes,
    );
    expect(error.message).toBe("The discount of 11.91 is more than the gross total of 11.90.");
  });

  it("refuses a discount row of another document instead of replacing it", async () => {
    const client = new FakeSevdeskClient(
      withRoutes(orderUpdateRoutes, discountsRoute("Order", 3102, [discountRow("Order", 3103)])),
    );
    await expect(
      prepareWrite(orderUpdateDraftTool, { id: 3102, discount: null }, client),
    ).rejects.toMatchObject({ kind: "unexpected_response" });
    expect(client.writes()).toEqual([]);
  });
});
