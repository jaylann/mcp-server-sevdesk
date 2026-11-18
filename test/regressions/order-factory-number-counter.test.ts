/**
 * #134 (from #112): order confirmations and delivery notes made by sevDesk's order factories
 * shared their numbers.
 *
 * `createContractNoteFromOrder` and `createPackingListFromOrder` give the new AB or LI the
 * number its counter currently offers and do not move the counter (D-027, D-107): two made in a
 * row carried the same number, and the tools only reported the clash. Now each create moves the
 * counter past the new number afterwards (`getNextOrderNumber` with `useNextNumber=true`, once),
 * like the credit note path, and the tools hold the range's account-wide lock from `prepare` to
 * the end, so two calls of one account cannot both get a number before either moved the counter.
 *
 * The fakes below keep state like sevDesk (the counters, the orders), and every request takes a
 * tick, so calls without the lock do interleave.
 */
import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { reserveNextNumber } from "../../src/domain/drafts/numbering.js";
import type { Tier } from "../../src/safety/tiers.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import type { SevdeskRequest } from "../../src/sevdesk/types.js";
import { orderCreateConfirmationTool } from "../../src/tools/orders/create-confirmation.js";
import { orderCreateDeliveryNoteTool } from "../../src/tools/orders/create-delivery-note.js";
import { orderCreateDraftTool } from "../../src/tools/orders/draft-create.js";
import { ACCOUNT_ORDER_NUMBERS } from "../../src/tools/types.js";
import { createFakeFetch, envelope, sevdeskErrorResponse } from "../helpers/fake-fetch.js";
import { closeWriteHarnessesAfterEach, resultData, writeHarness } from "../helpers/write-flow.js";
import { executeWrite } from "../helpers/write-tools.js";
import {
  documentRoute,
  orderRow,
  positionRoutes,
  type Row,
  StagedClient,
} from "../unit/tools/lifecycle/helpers.js";
import { derivedRow, discountsOf, NEXT_ORDER_NUMBER, sentOffer } from "../write-cases/orders.js";

closeWriteHarnessesAfterEach();

type Range = "AB" | "LI";

const FACTORIES: Readonly<Record<string, Range>> = {
  "/Order/Factory/createContractNoteFromOrder": "AB",
  "/Order/Factory/createPackingListFromOrder": "LI",
};

/** Lets other pending calls run, as a real HTTP round trip would. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

async function harness() {
  // sevDesk's AB and LI counters, the reservations made on them, and the orders.
  const state = {
    counters: { AB: 1003, LI: 1001 } as Record<Range, number>,
    reservations: { AB: 0, LI: 0 } as Record<Range, number>,
    posts: 0,
    nextId: 3101,
    orders: [
      sentOffer,
      { ...sentOffer, id: "3005", orderNumber: "AN-1005" },
      // Order confirmations made without an offer (the recorded one points to offer 3001).
      orderRow({ origin: null }),
      orderRow({ id: "3006", orderNumber: "AB-1006", origin: null }),
    ] as Row[],
  };
  const h = await writeHarness({
    tools: [orderCreateConfirmationTool, orderCreateDeliveryNoteTool],
    routes: [
      {
        path: "/Order/{id}/getRelatedObjects",
        pathPattern: /^\/Order\/\d+\/getRelatedObjects$/,
        response: { body: { objects: [] } },
      },
      { path: "/Unity", response: { fixture: "meta/units.json" } },
      ...positionRoutes(),
    ],
  });
  const request = h.fake.request.bind(h.fake);
  vi.spyOn(h.fake, "request").mockImplementation(async (req: SevdeskRequest) => {
    await tick();
    const range = req.method === "POST" ? FACTORIES[req.path] : undefined;
    if (range !== undefined) {
      const source = (req.body as { id: number }).id;
      state.posts += 1;
      // As recorded: the new order gets the counter's current number; the counter stays.
      const row = derivedRow(
        String(state.nextId++),
        range,
        `${range}-${String(state.counters[range])}`,
        String(source),
      );
      state.orders.push(row);
      if (range === "AB") {
        state.orders = state.orders.map((order) =>
          order["id"] === String(source) ? { ...order, status: "500" } : order,
        );
      }
      return row;
    }
    if (req.method === "GET" && req.path === NEXT_ORDER_NUMBER) {
      const key = req.query?.["orderType"] as Range;
      const current = `${key}-${String(state.counters[key])}`;
      if (req.query?.["useNextNumber"] === "true") {
        state.counters[key] += 1;
        state.reservations[key] += 1;
      }
      return current;
    }
    const byId = /^\/Order\/(\d+)$/.exec(req.path);
    if (req.method === "GET" && byId !== null) {
      return state.orders.filter((order) => order["id"] === byId[1]);
    }
    return request(req);
  });
  vi.spyOn(h.fake, "list").mockImplementation(async (path, _query, options) => {
    await tick();
    // sevDesk ignores filters it does not know: every order, matched locally by the tools.
    const rows = path === "/Order" ? state.orders : [];
    const offset = options?.offset ?? 0;
    return { items: rows.slice(offset, offset + (options?.limit ?? 100)), total: rows.length };
  });
  return { ...h, state };
}

function numberOf(result: CallToolResult): unknown {
  const data = resultData(result) as { result?: { order?: { number?: string } } };
  return data.result?.order?.number;
}

describe("#134: order factories move the AB and LI counters", () => {
  it("gives two confirmations made at once different numbers, moving the counter once each", async () => {
    const { client, state } = await harness();
    const create = (orderId: number) => ({
      name: "sevdesk_order_create_confirmation",
      arguments: { orderId },
    });

    const all = await Promise.all([client.callTool(create(3001)), client.callTool(create(3005))]);

    expect(all.map((result) => result.isError === true)).toEqual([false, false]);
    expect(all.map(numberOf).sort()).toEqual(["AB-1003", "AB-1004"]);
    expect(state.posts).toBe(2);
    // One reservation per create, each after its own request: the counter is past both.
    expect(state.reservations).toEqual({ AB: 2, LI: 0 });
    expect(state.counters.AB).toBe(1005);
  });

  it("gives two delivery notes made at once different numbers, moving the counter once each", async () => {
    const { client, state } = await harness();
    const create = (orderId: number) => ({
      name: "sevdesk_order_create_delivery_note",
      arguments: { orderId },
    });

    const all = await Promise.all([client.callTool(create(3002)), client.callTool(create(3006))]);

    expect(all.map((result) => result.isError === true)).toEqual([false, false]);
    expect(all.map(numberOf).sort()).toEqual(["LI-1001", "LI-1002"]);
    expect(state.posts).toBe(2);
    expect(state.reservations).toEqual({ AB: 0, LI: 2 });
    expect(state.counters.LI).toBe(1003);
  });

  it("takes the range's account-wide lock in every tool that numbers an AB or LI", () => {
    expect(orderCreateConfirmationTool.locks?.({ orderId: 3001, allowDuplicate: false })).toEqual([
      ACCOUNT_ORDER_NUMBERS.AB,
      { objectName: "Order", id: "3001" },
    ]);
    expect(orderCreateDeliveryNoteTool.locks?.({ orderId: 3002, allowDuplicate: false })).toEqual([
      ACCOUNT_ORDER_NUMBERS.LI,
      { objectName: "Order", id: "3002" },
    ]);
    // The draft tool reserves its number in one request, but must not fall between a factory's
    // request and the reservation that moves the counter on.
    const draft = (type: string) =>
      orderCreateDraftTool.locks?.(orderCreateDraftTool.input.parse(draftArgs(type)));
    expect(draft("order_confirmation")).toEqual([ACCOUNT_ORDER_NUMBERS.AB]);
    expect(draft("delivery_note")).toEqual([ACCOUNT_ORDER_NUMBERS.LI]);
    expect(draft("offer")).toEqual([]);
    expect(ACCOUNT_ORDER_NUMBERS.AB).not.toEqual(ACCOUNT_ORDER_NUMBERS.LI);
  });

  it("sends the factory request once and leaves the counter alone when it fails", async () => {
    const client = new StagedClient(
      [
        documentRoute("order", sentOffer),
        discountsOf("3001"),
        { path: "/Order", response: { body: { objects: [] } } },
      ],
      [
        {
          method: "POST",
          path: "/Order/Factory/createContractNoteFromOrder",
          response: {
            error: new SevdeskError({ kind: "server", message: "The request failed (server)." }),
          },
        },
      ],
    );
    await expect(
      executeWrite(orderCreateConfirmationTool, { orderId: 3001 }, client),
    ).rejects.toMatchObject({ kind: "server" });
    expect(client.writes().map((call) => [call.method, call.path])).toEqual([
      ["POST", "/Order/Factory/createContractNoteFromOrder"],
    ]);
    // Nothing is known to exist, so no number is reserved for it.
    expect(client.calls.filter((call) => call.path === NEXT_ORDER_NUMBER)).toEqual([]);
  });

  it.each(["AB", "LI"] as const)(
    "never repeats the %s reservation that moves the counter, even after an HTTP 500",
    async (orderType) => {
      // A success is queued behind the failure: a retry would consume it and reserve a number.
      const fake = createFakeFetch(
        sevdeskErrorResponse(500, "Internal Server Error"),
        envelope("X"),
      );
      const client = createSevdeskClient(
        {
          token: "0123456789abcdef0123456789abcdef",
          baseUrl: "https://my.sevdesk.de/api/v1",
          allowedTiers: new Set<Tier>(["read", "write"]),
          readOnly: false,
          dryRun: false,
          requestsPerSecond: 1000,
          timeoutMs: 1000,
          userAgent: "test",
        },
        { fetch: fake.fetch, sleep: () => Promise.resolve() },
      );
      const scoped = {
        ...client,
        request: (req: SevdeskRequest) => client.request({ ...req, tier: "write" }),
      };
      await expect(reserveNextNumber(scoped, { kind: "order", orderType })).rejects.toMatchObject({
        kind: "server",
      });
      expect(fake.requests).toHaveLength(1);
      expect(fake.pending).toBe(1);
      expect(fake.requests[0]?.url.searchParams.get("useNextNumber")).toBe("true");
      expect(fake.requests[0]?.url.searchParams.get("orderType")).toBe(orderType);
    },
  );
});

/** The smallest valid `sevdesk_order_create_draft` arguments of `type`. */
function draftArgs(type: string): Record<string, unknown> {
  return {
    type,
    contactId: 1001,
    positions: [{ name: "Beratung", quantity: "1", unitPrice: "100", taxRate: "19" }],
  };
}
