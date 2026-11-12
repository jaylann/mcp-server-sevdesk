/**
 * D-002 contradicted by the recording session (2026-11-07): `countAll` totals and `paidAmount`
 * come back as JSON numbers (or null), not strings; sums such as `sumGross` stayed strings. Unsent
 * documents carry `sendType: "0"`. The real client and the mappers must accept both forms; these tests run
 * the recorded responses through them.
 */
import { describe, expect, it } from "vitest";

import { getCreditNote } from "../../../src/domain/credit-notes.js";
import { listInvoices, mapInvoiceDetail } from "../../../src/domain/invoices.js";
import { readLifecycleDocument } from "../../../src/domain/lifecycle/documents.js";
import { mapOrderDetail } from "../../../src/domain/orders.js";
import { createSevdeskClient } from "../../../src/sevdesk/client.js";
import { parseTotal } from "../../../src/sevdesk/envelope.js";
import { allEnabledConfig } from "../../helpers/config.js";
import { FakeSevdeskClient, loadFixture } from "../../helpers/fake-client.js";
import { createFakeClock, createFakeFetch, jsonResponse } from "../../helpers/fake-fetch.js";

const DIR = "recorded/2026-11-07";

function recorded(path: string): { objects: Record<string, unknown>[]; total?: unknown } {
  return loadFixture(`${DIR}/${path}`).body as {
    objects: Record<string, unknown>[];
    total?: unknown;
  };
}

/** The real HTTP client answering every request with `body`. */
function realClient(...bodies: unknown[]) {
  const fake = createFakeFetch(...bodies.map((body) => jsonResponse(body)));
  const clock = createFakeClock();
  const client = createSevdeskClient(allEnabledConfig({ requestsPerSecond: 1000 }), {
    fetch: fake.fetch,
    sleep: clock.sleep,
    now: clock.now,
    monotonicNow: clock.now,
    random: () => 0.5,
  });
  return { client, fake };
}

describe("D-002: numeric scalars in recorded responses", () => {
  it.each([
    ["invoices/invoices-list.json", 39],
    ["credit-notes/credit-notes-list.json", 10],
    ["banking/transactions-list.json", 8],
    ["vouchers/vouchers-list.json", 0],
    ["meta/static-countries.json", 254],
  ])("parses the numeric countAll total of %s", (path, total) => {
    const body = recorded(path);
    expect(typeof body.total).toBe("number");
    expect(parseTotal(body.total)).toBe(total);
  });

  it("lists invoices through the real client with a numeric total and numeric paidAmount", async () => {
    const page = recorded("invoices/invoices-list.json");
    const { client, fake } = realClient(page);

    const result = await listInvoices(client, { limit: 5, offset: 0, today: "2026-11-08" });

    expect(fake.requests[0]?.url.searchParams.get("countAll")).toBe("1");
    expect(result.total).toBe(39);
    expect(result.items).toHaveLength(page.objects.length);
    const first = result.items[0];
    expect(page.objects[0]?.["paidAmount"]).toBe(0);
    expect(first?.paid).toEqual({ amount: "0.00", currency: "EUR" });
    expect(first?.totals.gross).toEqual({ amount: "119.00", currency: "EUR" });
    // paidAmount null (recorded on a finalized invoice) means "not reported", not zero.
    const unreported = page.objects.findIndex((row) => row["paidAmount"] === null);
    expect(unreported).toBeGreaterThanOrEqual(0);
    expect(result.items[unreported]?.paid).toBeUndefined();
  });

  it("maps a recorded invoice: numeric paidAmount, sendType 0 = not sent", () => {
    const raw = recorded("invoices/invoice-by-id.json").objects[0];
    expect(raw?.["sendType"]).toBe("0");
    const invoice = mapInvoiceDetail(raw, "2026-11-08");
    expect(invoice.paid).toEqual({ amount: "0.00", currency: "EUR" });
    expect(invoice.sent).toBeUndefined();
  });

  it("keeps the send date of a sent order whose sendType is 0, without a send type", () => {
    const raw = recorded("orders/order-by-id.json").objects[0];
    expect(raw).toMatchObject({ status: "200", sendType: "0" });
    expect(mapOrderDetail(raw).sent).toEqual({ date: "2026-11-07" });
  });

  it("reads the numeric paidAmount of the lifecycle snapshot as an exact decimal", async () => {
    const id = Number(recorded("invoices/invoice-by-id.json").objects[0]?.["id"]);
    const client = new FakeSevdeskClient([
      { path: `/Invoice/${id}`, response: { fixture: `${DIR}/invoices/invoice-by-id.json` } },
      { path: "/StaticCountry", response: { fixture: `${DIR}/meta/static-countries.json` } },
    ]);
    const doc = await readLifecycleDocument(client, "invoice", id, undefined, "2026-11-08");
    expect(doc.paidAmount).toBe("0");
  });

  it("maps a recorded credit note read through the real client", async () => {
    const creditNote = recorded("credit-notes/credit-note-by-id.json");
    const positions = recorded("credit-notes/credit-note-positions.json");
    const units = recorded("meta/units.json");
    const id = Number(creditNote.objects[0]?.["id"]);
    const { client } = realClient(
      creditNote,
      positions,
      units,
      recorded("meta/static-countries.json"),
    );
    const details = await getCreditNote(client, id);
    expect(details.creditNote.sent).toEqual({ date: "2026-11-07", via: "print" });
    expect(details.creditNote.totals.gross?.currency).toBe("EUR");
  });
});
