/**
 * Less common paths of the draft tools: several changes at once, tax text and currency changes,
 * stored settings that cannot be kept, long position lists, and sevDesk errors that are passed on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { creditNoteCreateDraftTool } from "../../../../src/tools/credit-notes/draft-create.js";
import { invoiceCreateDraftTool } from "../../../../src/tools/invoices/draft-create.js";
import { invoiceUpdateDraftTool } from "../../../../src/tools/invoices/draft-update.js";
import { orderUpdateDraftTool } from "../../../../src/tools/orders/draft-update.js";
import type { AnyWriteToolDefinition } from "../../../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { prepareWrite } from "../../../helpers/write-tools.js";
import {
  creditNoteCreateArgs,
  creditNoteCreateRoutes,
  invoiceCreateRoutes,
  invoiceUpdateRoutes,
  orderUpdateRoutes,
  withRoutes,
} from "./routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

const serverError = (path: string, query?: Record<string, string>): FakeRoute => ({
  path,
  ...(query === undefined ? {} : { query }),
  response: { error: new SevdeskError({ kind: "server", message: "sevDesk failed." }) },
});

function stored(fixture: string, path: string, fields: Record<string, unknown>): FakeRoute {
  const body = loadFixture(fixture).body as { objects: Record<string, unknown>[] };
  return { path, response: { body: { objects: [{ ...body.objects[0], ...fields }] } } };
}

/** Contact 1002 (a person) with one address. */
const contact1002: FakeRoute[] = [
  { path: "/Contact/1002", response: { fixture: "contacts/contact-1002.json" } },
  {
    path: "/ContactAddress",
    query: { "contact[id]": 1002 },
    response: {
      body: {
        objects: [
          {
            id: "3101",
            objectName: "ContactAddress",
            contact: { id: "1002", objectName: "Contact" },
            street: "Hauptstraße 9",
            zip: "54321",
            city: "Beispielstadt",
            country: { id: "1", objectName: "StaticCountry" },
            category: { id: "47", objectName: "Category" },
            name: null,
          },
        ],
      },
    },
  },
  {
    path: "/CommunicationWay",
    query: { "contact[id]": 1002 },
    response: { body: { objects: [] } },
  },
];

describe("draft order update: several changes at once", () => {
  it("lists every change and writes the new values", async () => {
    const client = new FakeSevdeskClient(withRoutes(orderUpdateRoutes, ...contact1002));
    const plan = await prepareWrite(
      orderUpdateDraftTool,
      {
        id: 3102,
        contactId: 1002,
        date: "2026-11-07",
        headText: "Neu",
        footText: "Neu",
        deliveryTerms: "Abholung",
        taxRule: 1,
        taxText: "zzgl. USt",
        currency: "CHF",
      },
      client,
    );
    expect(plan.state.body.order).toMatchObject({
      contact: { id: 1002, objectName: "Contact" },
      orderDate: "07.11.2026",
      headText: "Neu",
      footText: "Neu",
      deliveryTerms: "Abholung",
      taxRule: { id: 1, objectName: "TaxRule" },
      taxText: "zzgl. USt",
      currency: "CHF",
      address: "Dr. Max Mustermann\nHauptstraße 9\n54321 Beispielstadt",
    });
    expect(plan.preview.action).toBe(
      "Update draft Angebot 3102 for Dr. Max Mustermann (contact 1002): change contact, " +
        "address, date, intro text, closing text, delivery terms, tax, currency.",
    );
    expect(plan.preview.facts).toContainEqual({
      label: "Tax",
      value: "tax rule 1 Umsatzsteuerpflichtige Umsätze; text: zzgl. USt",
    });
    expect(plan.preview.warnings).toEqual([
      "The document is in CHF. Foreign-currency drafts are not verified against a live sevDesk " +
        "account yet; check the amounts in sevDesk before finalizing.",
    ]);
  });

  it("falls back to the type name when the stored order has no title", async () => {
    const untitled = stored("drafts/order-3102-draft.json", "/Order/3102", { header: null });
    const plan = await prepareWrite(
      orderUpdateDraftTool,
      { id: 3102, paymentTerms: "sofort" },
      new FakeSevdeskClient(withRoutes(orderUpdateRoutes, untitled)),
    );
    expect(plan.state.body.order.header).toBe("Angebot");
  });
});

describe("draft invoice update: tax and texts", () => {
  it("changes only the tax text and keeps the stored rule", async () => {
    const plan = await prepareWrite(
      invoiceUpdateDraftTool,
      { id: 2102, taxText: "zzgl. 19 % USt", headText: "Hallo", footText: "Tschüss" },
      new FakeSevdeskClient(invoiceUpdateRoutes),
    );
    expect(plan.state.body.invoice).toMatchObject({
      taxRule: { id: 1, objectName: "TaxRule" },
      taxText: "zzgl. 19 % USt",
      headText: "Hallo",
      footText: "Tschüss",
    });
    expect(plan.preview.action).toMatch(/: change intro text, closing text, tax\.$/);
  });

  it("keeps the stored rule's text when only the positions change", async () => {
    const plan = await prepareWrite(
      invoiceUpdateDraftTool,
      {
        id: 2102,
        priceMode: "gross",
        positions: [{ name: "A", quantity: 1, unitPrice: 119, taxRate: 19 }],
      },
      new FakeSevdeskClient(invoiceUpdateRoutes),
    );
    expect(plan.state.body.invoice).toMatchObject({ showNet: false, taxText: "Umsatzsteuer 19%" });
    expect(plan.preview.facts).toContainEqual({ label: "Prices entered as", value: "net → gross" });
  });

  it("refuses a stored tax setting it cannot keep", async () => {
    const odd = stored("drafts/invoice-2102-draft.json", "/Invoice/2102", {
      taxRule: null,
      taxType: "weird",
    });
    const client = new FakeSevdeskClient(withRoutes(invoiceUpdateRoutes, odd));
    await expect(
      prepareWrite(invoiceUpdateDraftTool, { id: 2102, header: "X" }, client),
    ).rejects.toMatchObject({
      kind: "validation",
      message: "This draft has no tax setting this server can keep. Pass taxRule to set one.",
    });
  });

  it("writes a stored draft without delivery date, title or tax text as it is", async () => {
    const bare = stored("drafts/invoice-2102-draft.json", "/Invoice/2102", {
      deliveryDate: null,
      header: null,
      taxText: null,
      timeToPay: null,
      currency: null,
      showNet: null,
    });
    const plan = await prepareWrite(
      invoiceUpdateDraftTool,
      { id: 2102, timeToPay: 10 },
      new FakeSevdeskClient(withRoutes(invoiceUpdateRoutes, bare)),
    );
    expect(plan.state.body.invoice).not.toHaveProperty("header");
    expect(plan.state.body.invoice).not.toHaveProperty("taxText");
    expect(plan.state.body.invoice).toMatchObject({
      currency: "EUR",
      showNet: true,
      timeToPay: 10,
    });
    expect(plan.preview.facts).toContainEqual({ label: "Payment term", value: "(none) → 10 days" });
    expect(plan.preview.facts).toContainEqual({
      label: "Delivery date",
      value: "(none) → 2026-11-02",
    });
  });
});

describe("draft previews and errors", () => {
  it("lists 20 positions and counts the rest", async () => {
    const positions = Array.from({ length: 23 }, (_, index) => ({
      name: `Position ${index + 1}`,
      quantity: 1,
      unitPrice: 1,
      taxRate: 19,
    }));
    const plan = await prepareWrite(
      invoiceCreateDraftTool,
      { contactId: 1001, positions },
      new FakeSevdeskClient(invoiceCreateRoutes),
    );
    expect(plan.preview.facts.filter((entry) => entry.label.startsWith("Position "))).toHaveLength(
      20,
    );
    expect(plan.preview.facts).toContainEqual({
      label: "More positions",
      value: "3 more, not listed here",
    });
  });

  it.each([
    [
      "the stored invoice",
      invoiceUpdateDraftTool,
      { id: 2102, header: "X" },
      invoiceUpdateRoutes,
      serverError("/Invoice/2102"),
    ],
    [
      "the source invoice",
      creditNoteCreateDraftTool,
      creditNoteCreateArgs,
      creditNoteCreateRoutes,
      serverError("/Invoice/1001", { embed: "contact" }),
    ],
  ] as const)(
    "passes on a sevDesk failure reading %s",
    async (_label, tool, args, routes, failing) => {
      const client = new FakeSevdeskClient(withRoutes(routes, failing));
      const write: AnyWriteToolDefinition = tool;
      await expect(prepareWrite(write, args, client)).rejects.toMatchObject({ kind: "server" });
      expect(client.writes()).toEqual([]);
    },
  );
});
