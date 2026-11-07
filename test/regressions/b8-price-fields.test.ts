/**
 * B8: position prices must be unambiguous. sevDesk reads a position's `price` as net when the
 * document's `showNet` is true and as gross when it is false (jernoxit/sevdesk-rs on Update 2.0: its
 * response recorded on 2026-10-01 for 3 × 10 + 25 with showNet true has sumNet 55; its live test
 * asserts sumGross 21.90 for 11.90 + 2 × 5.00 with showNet false; request shapes from its source). `priceNet` is read-only in the spec and no recording sends `priceGross` or
 * `priceTax` on create, so the draft tools send `price` only, exactly as given, with the
 * document's price mode, and never any derived total. The read-back flags a total that differs
 * from the preview.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creditNoteCreateDraftTool } from "../../src/tools/credit-notes/draft-create.js";
import { invoiceCreateDraftTool } from "../../src/tools/invoices/draft-create.js";
import { invoiceUpdateDraftTool } from "../../src/tools/invoices/draft-update.js";
import { orderCreateDraftTool } from "../../src/tools/orders/draft-create.js";
import type { AnyWriteToolDefinition } from "../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient } from "../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../helpers/write-tools.js";
import {
  creditNoteCreateArgs,
  creditNoteCreateRoutes,
  invoiceCreateArgs,
  invoiceCreateRoutes,
  invoiceUpdateRoutes,
  orderCreateArgs,
  orderCreateRoutes,
} from "../unit/tools/drafts/routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

const DERIVED = /^(sum|price(Net|Gross|Tax)$)/;

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, member]) => [key, ...keysOf(member)]);
}

const tools: readonly [
  string,
  AnyWriteToolDefinition,
  Record<string, unknown>,
  readonly FakeRoute[],
  string,
  string,
][] = [
  [
    "invoice",
    invoiceCreateDraftTool,
    invoiceCreateArgs,
    invoiceCreateRoutes,
    "invoice",
    "invoicePosSave",
  ],
  [
    "credit note",
    creditNoteCreateDraftTool,
    creditNoteCreateArgs,
    creditNoteCreateRoutes,
    "creditNote",
    "creditNotePosSave",
  ],
  ["order", orderCreateDraftTool, orderCreateArgs, orderCreateRoutes, "order", "orderPosSave"],
];

describe("B8: one unambiguous price per position", () => {
  it.each(tools)(
    "%s: price + showNet only, no derived values",
    async (_label, tool, args, routes, documentKey, positionsKey) => {
      for (const priceMode of ["net", "gross"] as const) {
        const plan = await prepareWrite(
          tool,
          { ...args, priceMode },
          new FakeSevdeskClient(routes),
        );
        const body = (plan.state as { body: Record<string, unknown> }).body;
        const document = body[documentKey] as Record<string, unknown>;
        const positions = body[positionsKey] as Record<string, unknown>[];
        expect(document["showNet"]).toBe(priceMode === "net");
        expect(keysOf(body).filter((key) => DERIVED.test(key))).toEqual([]);
        for (const position of positions) {
          expect(typeof position["price"]).toBe("string");
        }
      }
    },
  );

  it("sends the unit price exactly as given, in the given mode", async () => {
    const plan = await prepareWrite(
      invoiceCreateDraftTool,
      {
        contactId: 1001,
        priceMode: "gross",
        positions: [{ name: "Ticket", quantity: 1, unitPrice: "11.9", taxRate: 19 }],
      },
      new FakeSevdeskClient(invoiceCreateRoutes),
    );
    expect(plan.state.body.invoice.showNet).toBe(false);
    expect(plan.state.body.invoicePosSave?.[0]?.price).toBe("11.90");
    expect(plan.preview.facts).toContainEqual({ label: "Prices entered as", value: "gross" });
  });

  it("refuses to change the price mode of stored positions without new prices", async () => {
    const client = new FakeSevdeskClient(invoiceUpdateRoutes);
    await expect(
      prepareWrite(invoiceUpdateDraftTool, { id: 2102, priceMode: "gross" }, client),
    ).rejects.toMatchObject({
      kind: "validation",
    });
    expect(client.writes()).toEqual([]);
  });

  it("flags a stored total that does not match the expected one", async () => {
    // The draft in the recorded response totals 65.45 gross; the same prices read as gross would total 55.00.
    const { output } = await executeWrite(
      invoiceCreateDraftTool,
      { ...invoiceCreateArgs, priceMode: "gross" },
      new FakeSevdeskClient(invoiceCreateRoutes),
    );
    expect(output.data.notes).toContain(
      "sevDesk computed a gross total of 65.45 EUR; the preview expected 55.00 EUR. Check the " +
        "positions and the price mode (net/gross) before finalizing.",
    );
  });
});
