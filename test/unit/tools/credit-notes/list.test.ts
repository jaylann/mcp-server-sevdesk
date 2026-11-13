import { describe, expect, it } from "vitest";

import { creditNoteRowSchema } from "../../../../src/domain/credit-notes.js";
import { creditNotesListTool as tool } from "../../../../src/tools/credit-notes/list.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const listRoute: FakeRoute = {
  path: "/CreditNote",
  query: { embed: "contact" },
  response: { fixture: "credit-notes/credit-notes-list.json" },
};

async function list(args: Record<string, unknown>, routes: readonly FakeRoute[] = [listRoute]) {
  const client = new FakeSevdeskClient(routes);
  const result = await tool.handler(tool.input.parse(args), testContext(client));
  // These existing assertions exercise the unchanged full/default contract.
  return {
    client,
    result: {
      ...result,
      data: {
        ...result.data,
        items: result.data.items.map((row) => creditNoteRowSchema.parse(row)),
      },
    },
  };
}

describe("sevdesk_credit_notes_list (community: recorded CreditNote shape, fake data)", () => {
  it("is a read tool with explicit annotations", () => {
    expect(tool.tier).toBe("read");
    expect(tool.toolset).toBe("credit-notes");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("maps filters to sevDesk's parameters and only GETs", async () => {
    const { client } = await list({
      status: "open",
      contactId: 1001,
      number: "GU-1001",
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(client.methods()).toEqual(["GET"]);
    expect(client.calls[0]?.query).toMatchObject({
      embed: "contact",
      status: 200,
      "contact[id]": 1001,
      "contact[objectName]": "Contact",
      creditNoteNumber: "GU-1001",
      // One second before 2026-10-01 00:00 CEST (D-046), and 2026-10-31 23:59:59 CET (DST ended
      // on 25 October).
      startDate: 1790805600 - 1,
      endDate: 1793487599,
      offset: 0,
    });
  });

  it("re-checks the credit note date against the range without a scan (D-046)", async () => {
    // The fake ignores startDate/endDate; the re-check keeps the range exact.
    const { result } = await list({ from: "2026-11-01" });
    expect(result.data.items.map((item) => item.id)).toEqual([2002]);
    expect(result.data).toMatchObject({ total: 3, hasMore: false });
    expect(result.data.filteredLocally).toBeUndefined();
  });

  it("re-checks the number on every row and reports the local filter", async () => {
    const { result } = await list({ number: "gu-1003" });
    expect(result.data.items.map((item) => item.id)).toEqual([2003]);
    expect(result.data).toMatchObject({ filteredLocally: true, hasMore: false });
    expect(result.data.total).toBeUndefined();
    expect(result.summary).toBe(
      "1 matching credit notes in rows 1–3 (filtered by this server, not sevDesk); end of list.",
    );
  });

  it("returns compact rows with booking category and source invoice", async () => {
    const { result } = await list({});
    expect(tool.output.parse(result.data)).toEqual(result.data);
    expect(result.data.items[0]).toEqual({
      id: 2001,
      number: "GU-1001",
      status: { code: 200, label: "Open / delivered", key: "open" },
      contact: { id: 1001, name: "Musterfirma GmbH" },
      date: "2026-10-22",
      currency: "EUR",
      totals: {
        net: { amount: "20.00", currency: "EUR" },
        tax: { amount: "3.80", currency: "EUR" },
        gross: { amount: "23.80", currency: "EUR" },
      },
      bookingCategory: {
        code: "UNDERACHIEVEMENT",
        key: "underachievement",
        label: "Underachievement of an invoice or voucher (Minderleistung)",
      },
      sourceInvoiceId: 1004,
      header: "Gutschrift Nr. GU-1001 zur Rechnung Nr. RE-1004",
      sent: { date: "2026-10-22", via: "email" },
      link: "https://my.sevdesk.de/cn/detail/type/CN/id/2001",
    });
    const [, draft, paid] = result.data.items;
    expect(draft).toMatchObject({
      id: 2002,
      status: { code: 100, label: "Draft", key: "draft" },
      contact: { id: 1001 },
      bookingCategory: { code: "PROVISION", label: "Provision", key: "provision" },
      link: "https://my.sevdesk.de/cn/edit/type/CN/id/2002",
    });
    expect(draft?.number).toBeUndefined();
    expect(draft?.sourceInvoiceId).toBeUndefined();
    // createFromInvoice sets origin instead of refSrcInvoice (measured by sevdesk-rs).
    expect(paid).toMatchObject({ id: 2003, sourceInvoiceId: 1003, enshrined: true });
    expect(result.summary).toBe("Credit notes 1–3 of 3.");
  });

  it("reads refSrcInvoice as a bare id too (the spec's tag text types it Integer)", async () => {
    const { result } = await list({}, [
      {
        ...listRoute,
        response: {
          body: { objects: [{ id: "1", status: "200", refSrcInvoice: "77", refSrcVoucher: 5 }] },
        },
      },
    ]);
    expect(result.data.items[0]).toMatchObject({ sourceInvoiceId: 77, sourceVoucherId: 5 });
  });

  it("keeps an unknown booking category with the label 'unknown'", async () => {
    const { result } = await list({}, [
      {
        ...listRoute,
        response: { body: { objects: [{ id: "1", status: "100", bookingCategory: "NEW" }] } },
      },
    ]);
    expect(result.data.items[0]?.bookingCategory).toEqual({ code: "NEW", label: "unknown" });
  });

  it("rejects unknown statuses and parameters", () => {
    expect(() => tool.input.parse({ status: "rejected" })).toThrow();
    expect(() => tool.input.parse({ overdueOnly: true })).toThrow();
  });

  it("fails loudly on a credit note it cannot read", async () => {
    const client = new FakeSevdeskClient([
      { ...listRoute, response: { body: { objects: [{ id: "1", status: "x" }] } } },
    ]);
    await expect(tool.handler(tool.input.parse({}), testContext(client))).rejects.toMatchObject({
      kind: "unexpected_response",
      message: "sevDesk returned a credit note in an unexpected format.",
    });
  });
});
