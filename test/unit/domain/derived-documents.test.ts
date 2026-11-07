import { describe, expect, it } from "vitest";

import {
  checkInvoiceCreditable,
  findCreditNotesForInvoice,
} from "../../../src/domain/derived-documents.js";
import { mapInvoiceDetail } from "../../../src/domain/invoices.js";
import { FakeSevdeskClient, loadFixture } from "../../helpers/fake-client.js";

const invoice1004 = () => {
  const body = loadFixture("masterdata/invoice-1004.json").body as { objects: object[] };
  return { ...(body.objects[0] as Record<string, unknown>) };
};

describe("findCreditNotesForInvoice", () => {
  it("lists by contact and matches origin or refSrcInvoice locally", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/CreditNote",
        response: {
          body: {
            objects: [
              { id: "3", refSrcInvoice: { id: "1004", objectName: "Invoice" } },
              { id: "1", origin: { id: "1004", objectName: "Invoice" } },
              { id: "2", origin: { id: "1005", objectName: "Invoice" }, refSrcInvoice: 1005 },
            ],
          },
        },
      },
    ]);
    expect(await findCreditNotesForInvoice(client, { invoiceId: 1004, contactId: 7 })).toEqual({
      ids: [1, 3],
      truncated: false,
    });
    expect(client.calls[0]?.query).toMatchObject({
      "contact[id]": 7,
      "contact[objectName]": "Contact",
    });
    expect(client.calls[0]?.query).not.toHaveProperty("origin[id]");
  });

  it("scans without a contact filter when the invoice has no contact", async () => {
    const client = new FakeSevdeskClient([
      { path: "/CreditNote", response: { body: { objects: [] } } },
    ]);
    await findCreditNotesForInvoice(client, { invoiceId: 1004, contactId: undefined });
    expect(client.calls[0]?.query).toEqual({ limit: 1000, offset: 0, countAll: true });
  });

  it("validates the invoice id before asking sevDesk", async () => {
    const client = new FakeSevdeskClient([]);
    await expect(
      findCreditNotesForInvoice(client, { invoiceId: 0, contactId: undefined }),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(client.calls).toEqual([]);
  });
});

describe("checkInvoiceCreditable", () => {
  it("looks for a cancellation by origin only when the invoice has no contact", async () => {
    const raw = { ...invoice1004(), contact: null };
    const client = new FakeSevdeskClient([
      { path: "/Invoice", response: { body: { objects: [] } } },
    ]);
    const result = await checkInvoiceCreditable(client, mapInvoiceDetail(raw, "2026-11-07"));
    expect(result).toEqual({ warnings: [] });
    expect(client.calls[0]?.query).toMatchObject({
      "origin[id]": 1004,
      "origin[objectName]": "Invoice",
    });
    expect(client.calls[0]?.query).not.toHaveProperty("contact[id]");
  });

  it("refuses non-revenue types before reading anything", async () => {
    const client = new FakeSevdeskClient([]);
    const detail = mapInvoiceDetail({ ...invoice1004(), invoiceType: "SR" }, "2026-11-07");
    await expect(checkInvoiceCreditable(client, detail)).rejects.toMatchObject({
      kind: "validation",
    });
    expect(client.calls).toEqual([]);
  });
});
