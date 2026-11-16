/**
 * Three requests a `write` tool could send until the client knew them, each binding or hard to
 * undo (recorded on the trial account on 2026-11-16):
 *
 * - creating a bank transaction, `POST /CheckAccountTransaction` (#88): the new row changes the
 *   account's balance and what can be booked; a delete only sets `deletedAt` and works only while
 *   the row is unbooked (D-096), and an enshrined row locks itself and the payment booked on it
 *   (D-098);
 * - accepting an offer (#89): `PUT /Order/{id}` with a `status` accepts or rejects it, and renumbers
 *   a draft offer on the way (D-108); `createContractNoteFromOrder` sets the source offer to
 *   accepted, even a draft one (D-107);
 * - saving a recurring invoice template, `saveInvoice` with `invoiceType` `WKR` (#91): sevDesk
 *   issues invoices from it later on its own (D-111, D-112).
 *
 * The tools that send them are `commit` tools. Both the HTTP client and the tier-stamping view a
 * write tool's `execute` gets (`tierScopedClient`) refuse each of them from a `write` tool before
 * anything is sent, while the neighbouring requests the shipped `write` tools rely on still go
 * out.
 */
import { describe, expect, it } from "vitest";

import type { Tier } from "../../src/safety/tiers.js";
import { createSevdeskClient, type SevdeskClientConfig } from "../../src/sevdesk/client.js";
import { SevdeskError } from "../../src/sevdesk/errors.js";
import { tierScopedClient } from "../../src/sevdesk/scoped-client.js";
import type { SevdeskRequest } from "../../src/sevdesk/types.js";
import { FakeSevdeskClient } from "../helpers/fake-client.js";
import { createFakeClock, createFakeFetch, envelope } from "../helpers/fake-fetch.js";

const base: SevdeskClientConfig = {
  token: "0123456789abcdef0123456789abcdef",
  baseUrl: "https://my.sevdesk.de/api/v1",
  allowedTiers: new Set<Tier>(["read", "write", "commit", "external"]),
  readOnly: false,
  dryRun: false,
  requestsPerSecond: 1000,
  timeoutMs: 1000,
  userAgent: "test",
};

function httpClient(replies: Response[] = []) {
  const fake = createFakeFetch(...replies);
  const clock = createFakeClock();
  const client = createSevdeskClient(base, {
    fetch: fake.fetch,
    sleep: clock.sleep,
    now: clock.now,
    monotonicNow: clock.now,
    random: () => 0.5,
  });
  return { client, fake };
}

async function refusal(run: () => Promise<unknown>): Promise<SevdeskError> {
  const caught: unknown = await run().catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(SevdeskError);
  if (!(caught instanceof SevdeskError)) throw new Error("not a SevdeskError");
  expect(caught.kind).toBe("blocked");
  return caught;
}

/** The binding requests, in the form the tools of #88, #89 and #91 will send them. */
const BINDING: readonly (readonly [string, SevdeskRequest])[] = [
  [
    "creating a bank transaction",
    {
      method: "POST",
      path: "/CheckAccountTransaction",
      body: {
        objectName: "CheckAccountTransaction",
        mapAll: true,
        valueDate: "2026-11-16",
        amount: -20,
        paymtPurpose: "Miete",
        checkAccount: { id: 5, objectName: "CheckAccount" },
        status: 100,
      },
    },
  ],
  ["accepting an offer", { method: "PUT", path: "/Order/7", body: { status: 500 } }],
  [
    "making an order confirmation from an offer",
    {
      method: "POST",
      path: "/Order/Factory/createContractNoteFromOrder",
      query: { "order[id]": 7, "order[objectName]": "Order" },
      body: { id: 7, objectName: "Order" },
    },
  ],
  [
    "saving a recurring invoice template",
    {
      method: "POST",
      path: "/Invoice/Factory/saveInvoice",
      body: {
        invoice: {
          objectName: "Invoice",
          mapAll: true,
          invoiceType: "WKR",
          status: 100,
          accountIntervall: "P0Y1M0W",
          accountStartDate: "16.11.2026",
        },
        invoicePosSave: [],
        invoicePosDelete: null,
      },
    },
  ],
  [
    "ending a recurring invoice template",
    {
      method: "POST",
      path: "/Invoice/Factory/saveInvoice",
      body: {
        invoice: { id: 9, objectName: "Invoice", mapAll: true, status: "50" },
        invoicePosSave: [],
        invoicePosDelete: null,
      },
    },
  ],
];

/** Requests shipped `write` tools send next to them; they must keep working. */
const NEIGHBOURS: readonly (readonly [string, SevdeskRequest])[] = [
  [
    "saving a regular invoice draft",
    {
      method: "POST",
      path: "/Invoice/Factory/saveInvoice",
      body: {
        invoice: { objectName: "Invoice", mapAll: true, invoiceType: "RE", status: 100 },
        invoicePosSave: null,
        invoicePosDelete: null,
      },
    },
  ],
  [
    "making a delivery note from an order",
    {
      method: "POST",
      path: "/Order/Factory/createPackingListFromOrder",
      query: { "order[id]": 7, "order[objectName]": "Order" },
      body: { id: 7, objectName: "Order" },
    },
  ],
  ["changing an order's header", { method: "PUT", path: "/Order/7", body: { header: "Angebot" } }],
];

describe("binding requests need the commit tier", () => {
  it.each(BINDING)("the HTTP client refuses %s from a write tool", async (_label, request) => {
    const { client, fake } = httpClient();
    const error = await refusal(() => client.request({ ...request, tier: "write" }));
    expect(error.message).toContain("needs at least the commit tier");
    expect(error.message).toContain("Nothing was sent.");
    expect(fake.requests).toHaveLength(0);
  });

  it.each(BINDING)("a write tool's client refuses %s", async (_label, request) => {
    const inner = new FakeSevdeskClient([]);
    const error = await refusal(() => tierScopedClient(inner, "write").request(request));
    expect(error.message).toContain("needs at least the commit tier");
    expect(inner.calls).toEqual([]);
  });

  it.each(BINDING)("a commit tool may send %s", async (_label, request) => {
    const { client, fake } = httpClient([envelope({ id: "7" })]);
    await expect(client.request({ ...request, tier: "commit" })).resolves.toEqual({ id: "7" });
    expect(fake.requests).toHaveLength(1);
  });

  it.each(NEIGHBOURS)("a write tool may still send %s", async (_label, request) => {
    const { client, fake } = httpClient([envelope({ id: "7" })]);
    await expect(client.request({ ...request, tier: "write" })).resolves.toEqual({ id: "7" });
    expect(fake.requests).toHaveLength(1);
  });
});
