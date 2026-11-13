import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { invoiceFromOrderTool as tool } from "../../../../src/tools/invoices/from-order.js";
import { withCountryRoute } from "../../../helpers/country-route.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  changingAfter,
  directContext,
  invoiceReadRoutes,
  patched,
  patchedRecord,
  routeTable,
  UNITS_ROUTE,
} from "./support.js";

const ORDER = "orders/order-3002.json";
const CREATE = "/Invoice/Factory/createInvoiceFromOrder";

const table: (readonly [string, FakeRoute])[] = [
  ["order", { path: "/Order/3002", query: { embed: "contact" }, response: { fixture: ORDER } }],
  [
    "positions",
    {
      path: "/OrderPos",
      query: { "order[id]": 3002, "order[objectName]": "Order" },
      response: { fixture: "orders/order-positions-3002.json" },
    },
  ],
  ["units", UNITS_ROUTE],
  [
    "related",
    {
      path: "/Order/3002/getRelatedObjects",
      response: { fixture: "orders/order-related-3002.json" },
    },
  ],
  [
    "create",
    {
      method: "POST",
      path: CREATE,
      response: { fixture: "masterdata/invoice-from-order-1101.json" },
    },
  ],
];

function routes(overrides: Partial<Record<string, FakeRoute["response"]>> = {}): FakeRoute[] {
  return withCountryRoute([
    ...routeTable(table, overrides),
    ...invoiceReadRoutes(
      1101,
      overrides["readBack"] ?? { fixture: "masterdata/invoice-1101.json" },
      { fixture: "masterdata/invoice-positions-1101.json" },
    ),
  ]);
}

const createdInvoice = (patch: Record<string, unknown>) =>
  patched("masterdata/invoice-1101.json", patch);

/** A recorded page of 1,000 positions with a larger total: reading stops at the cap. */
function manyPositions(): FakeRoute["response"] {
  const body = loadFixture("orders/order-positions-3002.json").body as { objects: object[] };
  const row = body.objects[0] ?? {};
  const objects = Array.from({ length: 1000 }, (_, index) => ({
    ...row,
    id: String(90_000 + index),
  }));
  return { body: { objects, total: "20000" } };
}

function order(patch: Record<string, unknown>): FakeRoute["response"] {
  return patched(ORDER, patch);
}

describe("sevdesk_invoice_create_from_order", () => {
  it("is a write tool with create annotations in the invoices toolset", () => {
    expect(tool.tier).toBe("write");
    expect(tool.toolset).toBe("invoices");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("previews an invoice for the whole order", async () => {
    const client = new FakeSevdeskClient(routes());
    const plan = await prepareWrite(tool, { orderId: 3002 }, client);
    expect(plan.preview).toEqual({
      action: "Create a draft invoice for the whole order (Rechnung) from Order AB-1002 (id 3002).",
      facts: [
        { label: "Order", value: "Order AB-1002 (id 3002) (Auftragsbestätigung)" },
        { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
        { label: "Order net", value: "144.02 EUR" },
        { label: "Order tax", value: expect.stringMatching(/ EUR$/) as string },
        { label: "Order gross", value: "171.38 EUR" },
        { label: "Creates", value: "invoice for the whole order (Rechnung)" },
      ],
      warnings: [
        "The invoice is created as a draft (Entwurf) with the order's positions; check it with " +
          "sevdesk_invoice_get and finalize it with sevdesk_invoice_finalize.",
      ],
      irreversible: false,
    });
    expect(client.writes()).toEqual([]);
  });

  it("creates the invoice, reads it back and reports invoice and order", async () => {
    const client = new FakeSevdeskClient(routes());
    const { output } = await executeWrite(tool, { orderId: 3002 }, client);
    expect(client.writes().map((call) => [call.method, call.path, call.tier, call.body])).toEqual([
      ["POST", CREATE, "write", { order: { id: 3002, objectName: "Order" }, partialType: "RE" }],
    ]);
    expect(output.data.invoice).toMatchObject({
      id: 1101,
      status: { code: 100 },
      origin: { objectName: "Order", id: 3002 },
    });
    expect(output.data.positions).toHaveLength(3);
    expect(output.data.orderId).toBe(3002);
    expect(output.data.orderStatus).toEqual({ code: 500, label: "Accepted", key: "accepted" });
    // The order read back unchanged, so only the invoice is affected.
    expect(output.affected).toEqual([{ objectName: "Invoice", id: "1101" }]);
    expect(output.summary).toBe(
      "Created invoice draft 1101 (RE) from order 3002; finalize it with sevdesk_invoice_finalize.",
    );
  });

  it("creates partial and advance invoices with amount and amount type", async () => {
    const partial = new FakeSevdeskClient(
      routes({ readBack: createdInvoice({ invoiceType: "TR" }) }),
    );
    const { plan } = await executeWrite(
      tool,
      { orderId: 3002, mode: "partial", amount: 30 },
      partial,
    );
    expect(partial.writes()[0]?.body).toEqual({
      order: { id: 3002, objectName: "Order" },
      partialType: "TR",
      type: "percentage",
      amount: 30,
    });
    expect(plan.preview.facts).toContainEqual({ label: "Amount", value: "30 % of the order" });
    // Invoice 1010 from this order exists (order-related-3002.json): amounts are not checked
    // against what is still open, and the preview says so.
    expect(plan.preview.warnings).toContain(
      "Invoices from this order exist already (invoice 1010): the amount is checked against the " +
        "whole order, not against what is still open on it. Check the earlier invoices with " +
        "sevdesk_order_get before invoicing more.",
    );

    const advance = new FakeSevdeskClient(
      routes({ readBack: createdInvoice({ invoiceType: "AR" }) }),
    );
    const run = await executeWrite(
      tool,
      { orderId: 3002, mode: "advance", amount: "100", amountType: "net" },
      advance,
    );
    expect(advance.writes()[0]?.body).toEqual({
      order: { id: 3002, objectName: "Order" },
      partialType: "AR",
      type: "net",
      amount: 100,
    });
    expect(run.plan.preview.facts).toContainEqual({ label: "Amount", value: "100.00 EUR net" });
    expect(run.plan.preview.action).toBe(
      "Create a draft advance invoice (Abschlagsrechnung) from Order AB-1002 (id 3002).",
    );
  });

  it("checks amounts against the mode and the order totals", async () => {
    const client = new FakeSevdeskClient(routes());
    const refuse = (args: Record<string, unknown>, message: string) =>
      expect(prepareWrite(tool, { orderId: 3002, ...args }, client)).rejects.toMatchObject({
        kind: "validation",
        message,
      });
    await refuse(
      { mode: "partial" },
      "mode partial needs amount (with amountType percentage, net or gross).",
    );
    await refuse(
      { amount: 10 },
      "amount only applies to partial and advance invoices; leave it out to invoice the whole " +
        "order, or set mode to partial or advance.",
    );
    await refuse({ mode: "advance", amount: 101 }, "A percentage amount is at most 100.");
    await refuse(
      { mode: "advance", amount: "171.39", amountType: "gross" },
      "amount (171.39 gross) is more than the gross total of Order 3002 " + "(171.38 EUR).",
    );
    await expect(
      prepareWrite(
        tool,
        { orderId: 3002, mode: "advance", amount: "171.38", amountType: "gross" },
        client,
      ),
    ).resolves.toBeDefined();
    expect(tool.input.safeParse({ orderId: 1, mode: "partial", amount: 0 }).success).toBe(false);
    expect(client.writes()).toEqual([]);
  });

  it.each([
    [100, "is still a draft. Finalize it first (sevdesk_order_finalize)"],
    [300, "was rejected (status 300)"],
    [1000, "is already fully invoiced (status 1000, Berechnet)"],
    [400, "has status 400, which this tool does not know"],
  ])("refuses an order with status %i", async (status, message) => {
    const client = new FakeSevdeskClient(routes({ order: order({ status: String(status) }) }));
    await expect(prepareWrite(tool, { orderId: 3002 }, client)).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining(message) as string,
    });
  });

  it("accepts sent and partially invoiced orders and offers", async () => {
    for (const patch of [{ status: "200" }, { status: "750" }, { orderType: "AN" }]) {
      const client = new FakeSevdeskClient(routes({ order: order(patch) }));
      await expect(prepareWrite(tool, { orderId: 3002 }, client)).resolves.toBeDefined();
    }
  });

  it("refuses delivery notes", async () => {
    const client = new FakeSevdeskClient(routes({ order: order({ orderType: "LI" }) }));
    await expect(prepareWrite(tool, { orderId: 3002 }, client)).rejects.toMatchObject({
      message: expect.stringContaining(
        "is a delivery note (LI); only offers (AN) and order confirmations (AB)",
      ) as string,
    });
  });

  it("allows partial invoices only with tax rule 1 or 11", async () => {
    const client = new FakeSevdeskClient(
      routes({ order: order({ taxRule: { id: "3", objectName: "TaxRule" } }) }),
    );
    await expect(
      prepareWrite(tool, { orderId: 3002, mode: "partial", amount: 50 }, client),
    ).rejects.toMatchObject({ message: expect.stringContaining("uses tax rule 3") as string });
    await expect(prepareWrite(tool, { orderId: 3002 }, client)).resolves.toBeDefined();

    const smallBusiness = new FakeSevdeskClient(
      routes({ order: order({ taxRule: { id: "11", objectName: "TaxRule" } }) }),
    );
    await expect(
      prepareWrite(tool, { orderId: 3002, mode: "partial", amount: 50 }, smallBusiness),
    ).resolves.toBeDefined();
  });

  it("refuses when an invoice draft from the order exists, unless allowDuplicate", async () => {
    const related = {
      body: {
        objects: [
          {
            id: "1101",
            objectName: "Invoice",
            invoiceNumber: null,
            invoiceType: "RE",
            status: "100",
          },
        ],
      },
    };
    const client = new FakeSevdeskClient(routes({ related }));
    await expect(prepareWrite(tool, { orderId: 3002 }, client)).rejects.toMatchObject({
      message:
        "An invoice draft from Order 3002 exists already: invoice 1101. Finish or " +
        "delete that draft (sevdesk_invoice_get), or call again with allowDuplicate: true to " +
        "create another one.",
    });
    const plan = await prepareWrite(tool, { orderId: 3002, allowDuplicate: true }, client);
    expect(plan.preview.warnings).toContain(
      "Creating it anyway (allowDuplicate): invoice draft 1101 from this order exists already.",
    );
  });

  it("warns when related documents, positions or the currency are uncertain", async () => {
    const client = new FakeSevdeskClient(
      routes({
        related: { error: new SevdeskError({ kind: "server", status: 500, message: "x" }) },
        order: order({ currency: "USD" }),
        positions: manyPositions(),
      }),
    );
    const plan = await prepareWrite(tool, { orderId: 3002, mode: "partial", amount: 10 }, client);
    expect(plan.preview.warnings.slice(1)).toEqual([
      "sevDesk did not list the order's related documents, so earlier invoice drafts could not " +
        "be checked.",
      "sevDesk refuses advance and partial invoices in a currency other than the account's " +
        "default currency.",
      "sevDesk had more order positions than could be read; the totals shown are sevDesk's.",
    ]);
  });

  it("reads the id of a nested answer and reports the invoice when the read-back fails", async () => {
    const nested = new FakeSevdeskClient(
      routes({
        create: { body: { objects: { invoice: { id: "1101", objectName: "Invoice" } } } },
      }),
    );
    const { output } = await executeWrite(tool, { orderId: 3002 }, nested);
    expect(output.data.invoice.id).toBe(1101);

    const failing = new FakeSevdeskClient([
      {
        path: "/Invoice/1101",
        response: { error: new SevdeskError({ kind: "network", message: "x" }) },
      },
      ...routes(),
    ]);
    await expect(executeWrite(tool, { orderId: 3002 }, failing)).rejects.toMatchObject({
      kind: "network",
      completedWrites: [{ objectName: "Invoice", id: "1101" }],
    });
  });

  it("fails as unexpected_response when the answer has no id", async () => {
    const client = new FakeSevdeskClient(routes({ create: { body: { objects: { ok: true } } } }));
    await expect(executeWrite(tool, { orderId: 3002 }, client)).rejects.toMatchObject({
      kind: "unexpected_response",
    });
  });

  it("warns about already invoiced amounts on a partially invoiced order without related list", async () => {
    const client = new FakeSevdeskClient(
      routes({
        order: order({ status: "750" }),
        related: { error: new SevdeskError({ kind: "server", status: 500, message: "x" }) },
      }),
    );
    const plan = await prepareWrite(tool, { orderId: 3002, mode: "partial", amount: 10 }, client);
    expect(plan.preview.warnings).toContain(
      "Invoices from this order exist already: the amount is checked against the whole order, " +
        "not against what is still open on it. Check the earlier invoices with " +
        "sevdesk_order_get before invoicing more.",
    );
    const full = await prepareWrite(tool, { orderId: 3002 }, client);
    expect(full.preview.warnings.some((text) => text.startsWith("Invoices from this order"))).toBe(
      false,
    );
  });

  it("lists the order in affected with its new status when sevDesk changed it", async () => {
    const base = new FakeSevdeskClient(routes({ readBack: createdInvoice({ invoiceType: "TR" }) }));
    // getOrder in prepare reads /Order/3002 once; the read after the write sees status 750.
    const client = changingAfter(base, "/Order/3002", 1, patchedRecord(ORDER, { status: "750" }));
    const { output } = await executeWrite(
      tool,
      { orderId: 3002, mode: "partial", amount: 30 },
      client,
    );
    expect(output.affected).toEqual([
      { objectName: "Invoice", id: "1101" },
      { objectName: "Order", id: "3002" },
    ]);
    expect(output.data.orderStatus).toMatchObject({ code: 750 });
  });

  it("lists the order when it cannot be read again, without failing the call", async () => {
    const client = new FakeSevdeskClient(routes());
    const plan = await prepareWrite(tool, { orderId: 3002 }, client);
    const broken = {
      request: (request: Parameters<FakeSevdeskClient["request"]>[0]) =>
        request.method === "GET" && request.path === "/Order/3002"
          ? Promise.reject(new SevdeskError({ kind: "network", message: "x" }))
          : client.request(request),
      list: client.list.bind(client),
      listAll: client.listAll.bind(client),
      download: client.download.bind(client),
    };
    const output = await tool.execute(
      tool.input.parse({ orderId: 3002 }),
      plan,
      directContext(broken),
    );
    expect(output.affected).toEqual([
      { objectName: "Invoice", id: "1101" },
      { objectName: "Order", id: "3002" },
    ]);
    expect(output.data).not.toHaveProperty("orderStatus");
  });

  it("refuses to claim a draft when the new invoice is not one, or not the expected type", async () => {
    const finalized = new FakeSevdeskClient(
      routes({ readBack: createdInvoice({ status: "200" }) }),
    );
    await expect(executeWrite(tool, { orderId: 3002 }, finalized)).rejects.toMatchObject({
      kind: "unexpected_response",
      message:
        "sevDesk created invoice 1101, but not as the expected draft: its status is 200, not " +
        "100 (draft). Check it with sevdesk_invoice_get before doing anything else.",
      completedWrites: [{ objectName: "Invoice", id: "1101" }],
    });

    const wrongType = new FakeSevdeskClient(routes());
    await expect(
      executeWrite(tool, { orderId: 3002, mode: "advance", amount: 10 }, wrongType),
    ).rejects.toMatchObject({
      message: expect.stringContaining("it has type RE instead of AR") as string,
    });

    const odd = new FakeSevdeskClient(routes({ readBack: createdInvoice({ invoiceType: "x!" }) }));
    await expect(executeWrite(tool, { orderId: 3002 }, odd)).rejects.toMatchObject({
      message: expect.stringContaining("it has another type instead of RE or ER") as string,
    });

    const otherOrder = new FakeSevdeskClient(
      routes({ readBack: createdInvoice({ origin: { id: "3001", objectName: "Order" } }) }),
    );
    await expect(executeWrite(tool, { orderId: 3002 }, otherOrder)).rejects.toMatchObject({
      message: expect.stringContaining("it points to another order") as string,
    });
  });

  it("accepts a final invoice (ER) for the whole order", async () => {
    const client = new FakeSevdeskClient(
      routes({ readBack: createdInvoice({ invoiceType: "ER" }) }),
    );
    const { output } = await executeWrite(tool, { orderId: 3002 }, client);
    expect(output.data.invoice.type.code).toBe("ER");
  });
});
