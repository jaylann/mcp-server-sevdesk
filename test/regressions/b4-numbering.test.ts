/**
 * B4: document numbers come from sevDesk's number ranges, never from this server.
 *
 * - Invoices: create payloads carry no `invoiceNumber`; `sendBy` assigns it (recorded 2026-11-07:
 *   a draft without a number finalized as RE-1000; sevdesk-rs's saveInvoice request, per its
 *   source, sends none either).
 * - Orders and credit notes: create payloads carry exactly the number sevDesk handed out with
 *   `getNext…Number?useNextNumber=true` right before the save (recorded 2026-11-07: `saveOrder`
 *   without a number answers 400; a credit note without one fails or half-fails at `sendBy`).
 *   `prepare` only peeks (`useNextNumber=false`); a different reserved number wins over the
 *   peeked one.
 * - Updates carry only the stored number unchanged (nothing when none is stored) and never
 *   reserve. The read-back says when a number is missing or still holds placeholders
 *   (spec/deviations.md D-027).
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
  nextCreditNoteNumberRoutes,
  nextOrderNumberRoutes,
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

/** Number keys anywhere in the body of the (only) save request. */
function numbersSent(client: FakeSevdeskClient): Record<string, unknown> {
  const saves = client.writes().filter((call) => call.method === "POST");
  expect(saves).toHaveLength(1);
  const found: Record<string, unknown> = {};
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === "object" && value !== null) {
      for (const [key, member] of Object.entries(value)) {
        if (NUMBER_KEYS.includes(key)) found[key] = member;
        visit(member);
      }
    }
  };
  visit(saves[0]?.body);
  return found;
}

describe("B4: no invented document numbers", () => {
  it("invoice create sends no number (sendBy assigns it)", async () => {
    const client = new FakeSevdeskClient(invoiceCreateRoutes);
    await executeWrite(invoiceCreateDraftTool, invoiceCreateArgs, client);
    expect(numbersSent(client)).toEqual({});
    expect(client.calls.some((call) => call.path.includes("getNext"))).toBe(false);
  });

  it.each([
    [
      "order",
      orderCreateDraftTool,
      orderCreateArgs,
      withRoutes(orderCreateRoutes, ...nextOrderNumberRoutes("AN-1000", "AN-1001")),
      "/Order/Factory/getNextOrderNumber",
      { orderNumber: "AN-1001" },
    ],
    [
      "credit note",
      creditNoteCreateDraftTool,
      creditNoteCreateArgs,
      withRoutes(creditNoteCreateRoutes, ...nextCreditNoteNumberRoutes("GU-1002", "GU-1003")),
      "/CreditNote/Factory/getNextCreditNoteNumber",
      { creditNoteNumber: "GU-1003" },
    ],
  ] as const)(
    "%s create sends exactly the number sevDesk reserved, never the peeked or an invented one",
    async (_label, tool, args, routes, path, expected) => {
      const client = new FakeSevdeskClient(routes);
      await executeWrite(tool as AnyWriteToolDefinition, args, client);
      expect(numbersSent(client)).toEqual(expected);
      const reservations = client.writes().filter((call) => call.path === path);
      expect(reservations.map((call) => call.query["useNextNumber"])).toEqual(["true"]);
      expect(client.writes().map((call) => call.method)).toEqual(["GET", "POST"]);
    },
  );

  it("invoice update without a stored number sends none", async () => {
    const plan = await prepareWrite(
      invoiceUpdateDraftTool,
      { id: 2102, header: "X" },
      new FakeSevdeskClient(invoiceUpdateRoutes),
    );
    expect(keysOf(plan.state.body).filter((key) => NUMBER_KEYS.includes(key))).toEqual([]);
  });

  it("order update keeps the stored number exactly and never reserves one", async () => {
    const client = new FakeSevdeskClient(orderUpdateRoutes);
    await executeWrite(orderUpdateDraftTool, { id: 3102, header: "X" }, client);
    expect(numbersSent(client)).toEqual({ orderNumber: "AN-1007" });
    expect(client.calls.some((call) => call.path.includes("getNext"))).toBe(false);
  });

  it("the input schemas do not accept a number", () => {
    expect(
      invoiceCreateDraftTool.input.safeParse({ ...invoiceCreateArgs, invoiceNumber: "RE-1" })
        .success,
    ).toBe(false);
    expect(
      orderCreateDraftTool.input.safeParse({ ...orderCreateArgs, orderNumber: "AN-2" }).success,
    ).toBe(false);
    expect(
      creditNoteCreateDraftTool.input.safeParse({
        ...creditNoteCreateArgs,
        creditNoteNumber: "GU-2",
      }).success,
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
