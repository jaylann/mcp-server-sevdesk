/**
 * The read side of cost centres (#87, spec/deviations.md D-091, D-092): the get tools show a
 * document's cost centre with number and name (one `GET /CostCentre`, only when one is set), and
 * the invoice and voucher list rows carry `costCentreId`, with the list's `costCentreFilter`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { creditNoteGetTool } from "../../../../src/tools/credit-notes/get.js";
import { creditNotesListTool } from "../../../../src/tools/credit-notes/list.js";
import { invoiceGetTool } from "../../../../src/tools/invoices/get.js";
import { invoicesListTool } from "../../../../src/tools/invoices/list.js";
import { voucherGetTool } from "../../../../src/tools/vouchers/get.js";
import { vouchersListTool } from "../../../../src/tools/vouchers/list.js";
import {
  costCentresRoute,
  RECORDED_CENTRES,
  storedCostCentre,
} from "../../../helpers/cost-centres.js";
import { withCountryRoute } from "../../../helpers/country-route.js";
import {
  type FakeRoute,
  FakeSevdeskClient,
  loadFixture,
  testContext,
} from "../../../helpers/fake-client.js";
import { creditNoteRow, invoiceRow, noDiscountsRoute, type Row } from "../lifecycle/helpers.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

const { first, third } = RECORDED_CENTRES;

/** The first row of a fixture with `fields` replaced, as a `GET /<path>` answer. */
function withFields(path: string, fixture: string, fields: Row, query?: FakeRoute["query"]) {
  const objects = (loadFixture(fixture).body as { objects: Row[] }).objects;
  const route: FakeRoute = {
    path,
    ...(query === undefined ? {} : { query }),
    response: { body: { objects: [{ ...structuredClone(objects[0]), ...fields }] } },
  };
  return route;
}

const unitsRoute: FakeRoute = { path: "/Unity", response: { fixture: "meta/units.json" } };

function invoiceRoutes(fields: Row): FakeRoute[] {
  return withCountryRoute([
    withFields("/Invoice/1001", "invoices/invoice-1001.json", fields, { embed: "contact" }),
    {
      path: "/InvoicePos",
      query: { "invoice[id]": 1001 },
      response: { fixture: "invoices/invoice-positions-1001.json" },
    },
    unitsRoute,
    noDiscountsRoute,
    costCentresRoute,
  ]);
}

function creditNoteRoutes(fields: Row): FakeRoute[] {
  return withCountryRoute([
    withFields("/CreditNote/2001", "credit-notes/credit-note-2001.json", fields, {
      embed: "contact",
    }),
    {
      path: "/CreditNotePos",
      query: { "creditNote[id]": 2001 },
      response: { fixture: "credit-notes/credit-note-positions-2001.json" },
    },
    unitsRoute,
    noDiscountsRoute,
    costCentresRoute,
  ]);
}

function voucherRoutes(fields: Row): FakeRoute[] {
  return [
    withFields("/Voucher/2001", "vouchers/voucher-2001.json", fields),
    {
      path: "/VoucherPos",
      query: { "voucher[id]": 2001 },
      response: { fixture: "vouchers/voucher-positions-2001.json" },
    },
    costCentresRoute,
  ];
}

describe("the get tools show the cost centre", () => {
  it("sevdesk_invoice_get: id on the invoice, number and name beside it", async () => {
    const client = new FakeSevdeskClient(invoiceRoutes({ costCentre: storedCostCentre(third.id) }));
    const tool = invoiceGetTool;
    const result = await tool.handler(tool.input.parse({ id: 1001 }), testContext(client));
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.invoice.costCentreId).toBe(third.id);
    expect(result.data.costCentre).toEqual(third);
    expect(client.methods().every((method) => method === "GET")).toBe(true);
  });

  it("sevdesk_credit_note_get", async () => {
    const client = new FakeSevdeskClient(
      creditNoteRoutes({ costCentre: storedCostCentre(first.id) }),
    );
    const tool = creditNoteGetTool;
    const result = await tool.handler(tool.input.parse({ id: 2001 }), testContext(client));
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.creditNote.costCentreId).toBe(first.id);
    expect(result.data.costCentre).toEqual(first);
  });

  it("sevdesk_voucher_get", async () => {
    const client = new FakeSevdeskClient(voucherRoutes({ costCentre: storedCostCentre(third.id) }));
    const tool = voucherGetTool;
    const result = await tool.handler(tool.input.parse({ id: 2001 }), testContext(client));
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.voucher.costCentreId).toBe(third.id);
    expect(result.data.costCentre).toEqual(third);
  });

  it("shows the id alone for a cost centre the list does not have", async () => {
    const client = new FakeSevdeskClient(voucherRoutes({ costCentre: storedCostCentre(77) }));
    const tool = voucherGetTool;
    const result = await tool.handler(tool.input.parse({ id: 2001 }), testContext(client));
    expect(result.data.costCentre).toEqual({ id: 77 });
  });

  it("shows the id alone when sevDesk refuses the cost-centre list", async () => {
    const refused: FakeRoute = {
      path: "/CostCentre",
      response: { error: new SevdeskError({ kind: "auth", status: 403, message: "Refused." }) },
    };
    const routes = invoiceRoutes({ costCentre: storedCostCentre(third.id) }).filter(
      (route) => route.path !== "/CostCentre",
    );
    const client = new FakeSevdeskClient([...routes, refused]);
    const tool = invoiceGetTool;
    const result = await tool.handler(tool.input.parse({ id: 1001 }), testContext(client));
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.costCentre).toEqual({ id: third.id });
    expect(client.callsTo("/CostCentre")).toHaveLength(1);
  });

  it("still fails a cancelled call on the cost-centre list", async () => {
    const cancelled: FakeRoute = {
      path: "/CostCentre",
      response: { error: new SevdeskError({ kind: "aborted", message: "Cancelled." }) },
    };
    const routes = voucherRoutes({ costCentre: storedCostCentre(third.id) }).filter(
      (route) => route.path !== "/CostCentre",
    );
    const tool = voucherGetTool;
    await expect(
      tool.handler(
        tool.input.parse({ id: 2001 }),
        testContext(new FakeSevdeskClient([...routes, cancelled])),
      ),
    ).rejects.toMatchObject({ kind: "aborted" });
  });

  it("reads no cost centres for a document without one", async () => {
    for (const fields of [{ costCentre: null }, {}]) {
      const client = new FakeSevdeskClient(voucherRoutes(fields));
      const tool = voucherGetTool;
      const result = await tool.handler(tool.input.parse({ id: 2001 }), testContext(client));
      expect(result.data).not.toHaveProperty("costCentre");
      expect(result.data.voucher).not.toHaveProperty("costCentreId");
      expect(client.callsTo("/CostCentre")).toEqual([]);
    }
  });
});

describe("the list rows carry costCentreId", () => {
  it("sevdesk_invoices_list, with and without the filter", async () => {
    const rows = [
      invoiceRow({ id: "501", costCentre: storedCostCentre(third.id) }),
      invoiceRow({ id: "502", costCentre: null }),
    ];
    const client = new FakeSevdeskClient([
      costCentresRoute,
      { path: "/Invoice", response: { body: { objects: rows } } },
    ]);
    const tool = invoicesListTool;
    const all = await tool.handler(tool.input.parse({}), testContext(client));
    expect(tool.output.parse(all.data)).toEqual(all.data);
    expect(
      all.data.items.map((item) => ("costCentreId" in item ? item.costCentreId : "-")),
    ).toEqual([third.id, "-"]);
    expect(all.data).not.toHaveProperty("costCentreFilter");
    expect(client.callsTo("/CostCentre")).toEqual([]);

    const filtered = await tool.handler(
      tool.input.parse({ costCentre: third.id }),
      testContext(client),
    );
    expect(tool.output.parse(filtered.data)).toEqual(filtered.data);
    expect(filtered.data.items.map((item) => item.id)).toEqual([501]);
    expect(filtered.data.costCentreFilter).toEqual(third);
  });

  it("sevdesk_vouchers_list", async () => {
    const objects = (loadFixture("vouchers/voucher-2001.json").body as { objects: Row[] }).objects;
    const rows = [
      { ...structuredClone(objects[0]), id: "601", costCentre: storedCostCentre(first.id) },
      { ...structuredClone(objects[0]), id: "602" },
    ];
    const client = new FakeSevdeskClient([
      costCentresRoute,
      { path: "/Voucher", response: { body: { objects: rows } } },
    ]);
    const tool = vouchersListTool;
    const filtered = await tool.handler(
      tool.input.parse({ costCentre: "M62573C" }),
      testContext(client),
    );
    expect(tool.output.parse(filtered.data)).toEqual(filtered.data);
    expect(filtered.data.items).toEqual([
      expect.objectContaining({ id: 601, costCentreId: first.id }),
    ]);
    expect(filtered.data.costCentreFilter).toEqual(first);
  });

  it("sevdesk_credit_notes_list, with the filter recorded on 2026-11-17 (D-092)", async () => {
    const rows = [
      creditNoteRow({ id: "701", costCentre: storedCostCentre(third.id) }),
      creditNoteRow({ id: "702" }),
    ];
    const client = new FakeSevdeskClient([
      costCentresRoute,
      { path: "/CreditNote", response: { body: { objects: rows } } },
    ]);
    const tool = creditNotesListTool;
    const filtered = await tool.handler(
      tool.input.parse({ costCentre: "MCP1" }),
      testContext(client),
    );
    expect(tool.output.parse(filtered.data)).toEqual(filtered.data);
    expect(filtered.data.items).toEqual([
      expect.objectContaining({ id: 701, costCentreId: third.id }),
    ]);
    expect(filtered.data.costCentreFilter).toEqual(third);
    expect(client.callsTo("/CreditNote")[0]?.query).toMatchObject({
      "costCentre[id]": third.id,
      "costCentre[objectName]": "CostCentre",
    });
  });
});
