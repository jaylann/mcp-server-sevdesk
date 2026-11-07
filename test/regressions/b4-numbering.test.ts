/**
 * B4: document numbers come from sevDesk's number range, never from this server. Create payloads
 * carry no `invoiceNumber`, `creditNoteNumber` or `orderNumber` (sevdesk-rs's saveInvoice request
 * sends none, per its source, and its recorded response is a draft
 * without one reads back with `invoiceNumber: null`, and sendBy assigns it); update payloads only
 * carry the stored number unchanged, and nothing when none is stored. The read-back says when a
 * number is missing or still holds placeholders (spec/deviations.md D-027).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creditNoteCreateDraftTool } from "../../src/tools/credit-notes/draft-create.js";
import { invoiceCreateDraftTool } from "../../src/tools/invoices/draft-create.js";
import { invoiceUpdateDraftTool } from "../../src/tools/invoices/draft-update.js";
import { orderCreateDraftTool } from "../../src/tools/orders/draft-create.js";
import { orderUpdateDraftTool } from "../../src/tools/orders/draft-update.js";
import type { AnyWriteToolDefinition } from "../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../helpers/write-tools.js";
import {
  creditNoteCreateArgs,
  creditNoteCreateRoutes,
  invoiceCreateArgs,
  invoiceCreateRoutes,
  invoiceUpdateRoutes,
  orderCreateArgs,
  orderCreateRoutes,
  orderUpdateRoutes,
  withRoutes,
} from "../unit/tools/drafts/routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

const NUMBER_KEYS = ["invoiceNumber", "creditNoteNumber", "orderNumber"];

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, member]) => [key, ...keysOf(member)]);
}

describe("B4: no invented document numbers", () => {
  it.each([
    ["invoice", invoiceCreateDraftTool, invoiceCreateArgs, invoiceCreateRoutes],
    ["credit note", creditNoteCreateDraftTool, creditNoteCreateArgs, creditNoteCreateRoutes],
    ["order", orderCreateDraftTool, orderCreateArgs, orderCreateRoutes],
  ] as const)("%s create sends no number", async (_label, tool, args, routes) => {
    const client = new FakeSevdeskClient(routes);
    await executeWrite(tool as AnyWriteToolDefinition, args, client);
    const [save] = client.writes();
    expect(keysOf(save?.body).filter((key) => NUMBER_KEYS.includes(key))).toEqual([]);
  });

  it("invoice update without a stored number sends none", async () => {
    const plan = await prepareWrite(
      invoiceUpdateDraftTool,
      { id: 2102, header: "X" },
      new FakeSevdeskClient(invoiceUpdateRoutes),
    );
    expect(keysOf(plan.state.body).filter((key) => NUMBER_KEYS.includes(key))).toEqual([]);
  });

  it("order update keeps the stored number exactly", async () => {
    const plan = await prepareWrite(
      orderUpdateDraftTool,
      { id: 3102, header: "X" },
      new FakeSevdeskClient(orderUpdateRoutes),
    );
    expect(plan.state.body.order.orderNumber).toBe("AN-1007");
  });

  it("the input schemas do not accept a number", () => {
    expect(
      invoiceCreateDraftTool.input.safeParse({ ...invoiceCreateArgs, invoiceNumber: "RE-1" })
        .success,
    ).toBe(false);
    expect(orderUpdateDraftTool.input.safeParse({ id: 3102, orderNumber: "AN-2" }).success).toBe(
      false,
    );
  });

  it("the read-back notes a missing number and one with placeholders", async () => {
    const created = await executeWrite(
      invoiceCreateDraftTool,
      invoiceCreateArgs,
      new FakeSevdeskClient(invoiceCreateRoutes),
    );
    expect(created.output.data.notes?.[0]).toMatch(/^The invoice has no number yet/);

    const stored = loadFixture("drafts/order-3102-draft.json").body as {
      objects: Record<string, unknown>[];
    };
    const placeholder: FakeRoute = {
      path: "/Order/3102",
      query: { embed: "contact" },
      response: { body: { objects: [{ ...stored.objects[0], orderNumber: "AN-%YYYY%1007" }] } },
    };
    const updated = await executeWrite(
      orderUpdateDraftTool,
      { id: 3102, header: "X" },
      new FakeSevdeskClient(withRoutes(orderUpdateRoutes, placeholder)),
    );
    expect(updated.output.data.notes).toEqual([
      "The order number still contains placeholders (%…%). Check the number range " +
        "(Nummernkreis) in sevDesk's settings before finalizing.",
    ]);
  });
});
