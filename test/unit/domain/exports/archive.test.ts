import { describe, expect, it } from "vitest";

import {
  archiveFilename,
  type ArchiveParams,
  archiveQuery,
  exportArchive,
  isDraftEntry,
  MAX_ARCHIVE_BYTES,
  mediaType,
} from "../../../../src/domain/exports/archive.js";
import { resolveGetSafety } from "../../../../src/sevdesk/paths.js";
import { readOnlyClient, tierScopedClient } from "../../../../src/sevdesk/scoped-client.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { buildZip, pdfBytes } from "../../../helpers/zip.js";

const INVOICES: ArchiveParams = {
  subject: "invoices",
  from: "2026-10-01",
  to: "2026-10-31",
  limit: 1000,
};

/** The recorded entry names of D-101, with fake numbers and hashes. */
const RECORDED = buildZip([
  {
    name: "2026-10-05_Rechnung_RE-1000_0123456789abcdef0123456789abcdef.pdf",
    content: pdfBytes("1"),
  },
  {
    name: "2026-10-07_Rechnung_RE-1001_fedcba9876543210fedcba9876543210.pdf",
    content: pdfBytes("2"),
  },
  {
    name: "2026-10-09_Rechnung(Entwurf)__00112233445566778899aabbccddeeff.pdf",
    content: pdfBytes("3"),
  },
]);

/** sevDesk's recorded media type, stray apostrophe included. */
const RECORDED_TYPE = "application/zip; charset=UTF-8'";

function zipClient(path: string, bytes: Uint8Array, contentType?: string): FakeSevdeskClient {
  return new FakeSevdeskClient([
    { path, response: { bytes, ...(contentType === undefined ? {} : { contentType }) } },
  ]);
}

describe("archiveQuery", () => {
  it("sends download=true, the sevQuery frame with an explicit limit and the period in Unix seconds", () => {
    expect(archiveQuery({ ...INVOICES, limit: 50 })).toEqual({
      download: "true",
      "sevQuery[objectName]": "SevQuery",
      "sevQuery[modelName]": "Invoice",
      "sevQuery[limit]": 50,
      "sevQuery[filter][startDate]": Date.parse("2026-10-01T00:00:00+02:00") / 1000,
      "sevQuery[filter][endDate]": Date.parse("2026-11-01T00:00:00+01:00") / 1000 - 1,
    });
  });

  it("adds the recorded filters: the contact for invoices, the gross range for vouchers", () => {
    expect(archiveQuery({ ...INVOICES, contactId: 42 })).toMatchObject({
      "sevQuery[filter][contact][id]": 42,
      "sevQuery[filter][contact][objectName]": "Contact",
    });
    expect(
      archiveQuery({ ...INVOICES, subject: "vouchers", minAmount: "123", maxAmount: "124.5" }),
    ).toMatchObject({
      "sevQuery[modelName]": "Voucher",
      "sevQuery[filter][startAmount]": "123",
      "sevQuery[filter][endAmount]": "124.5",
    });
  });

  it("is a side effect for the client, and never carries an enshrine flag", () => {
    for (const path of ["/Export/invoiceZip", "/Export/voucherZip"]) {
      const query = archiveQuery(INVOICES);
      expect(resolveGetSafety(path, query, false).sideEffect).toBe(true);
      expect(Object.keys(query).filter((key) => /enshrine|exported/i.test(key))).toEqual([]);
    }
  });
});

describe("exportArchive", () => {
  it("accepts the recorded raw ZIP with the stray apostrophe and counts entries and drafts", async () => {
    const client = zipClient("/Export/invoiceZip", RECORDED, RECORDED_TYPE);

    const archive = await exportArchive(tierScopedClient(client, "write"), INVOICES);

    expect(archive).toEqual({ bytes: RECORDED, entries: 3, pdfEntries: 3, draftEntries: 1 });
    expect(client.writes()).toEqual([
      expect.objectContaining({
        operation: "download",
        method: "GET",
        path: "/Export/invoiceZip",
        sideEffect: true,
        tier: "write",
      }),
    ]);
  });

  it("asks the voucher archive with the voucher model", async () => {
    const zip = buildZip([
      { name: "2026-10-09_Beleg_Bueromaterial_0011.pdf", content: pdfBytes("v") },
      { name: "2026-10-09_Beleg(Entwurf)_Kaffee_0022.pdf", content: pdfBytes("w") },
    ]);
    const client = zipClient("/Export/voucherZip", zip, "application/zip");

    const archive = await exportArchive(tierScopedClient(client, "write"), {
      ...INVOICES,
      subject: "vouchers",
      minAmount: "100",
    });

    expect(archive).toMatchObject({ entries: 2, draftEntries: 1 });
    expect(client.writes()[0]?.query).toMatchObject({ "sevQuery[modelName]": "Voucher" });
  });

  it("decodes the JSON form when it carries the file", async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        objects: {
          filename: "Rechnungen_16.11.26.zip",
          mimetype: "application/zip",
          base64Encoded: true,
          content: Buffer.from(RECORDED).toString("base64"),
        },
      }),
    );
    const client = zipClient("/Export/invoiceZip", body, "application/json");

    await expect(exportArchive(tierScopedClient(client, "write"), INVOICES)).resolves.toMatchObject(
      { entries: 3 },
    );
  });

  it.each([
    [
      "the JSON form without content (D-101)",
      JSON.stringify({ objects: { filename: "x.zip", base64Encoded: true, content: null } }),
      "application/json",
    ],
    ["an HTML error page", "<html>Fehler</html>", "text/html; charset=UTF-8"],
    ["plain bytes with a ZIP type", "not a zip", RECORDED_TYPE],
    ["unreadable JSON", "{oops", undefined],
  ] as const)("refuses %s and saves nothing", async (_label, text, type) => {
    const client = zipClient("/Export/invoiceZip", new TextEncoder().encode(text), type);

    const error = await exportArchive(tierScopedClient(client, "write"), INVOICES).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ kind: "unexpected_response" });
    expect((error as Error).message).toContain("Nothing was saved");
    expect((error as Error).message).not.toContain("Fehler");
  });

  it("refuses ZIP magic without a readable directory", async () => {
    const cut = RECORDED.subarray(0, RECORDED.length - 30);
    const client = zipClient("/Export/invoiceZip", cut, RECORDED_TYPE);
    await expect(exportArchive(tierScopedClient(client, "write"), INVOICES)).rejects.toMatchObject({
      kind: "unexpected_response",
    });
  });

  it("is blocked by a read-only client before anything is sent", async () => {
    const client = zipClient("/Export/invoiceZip", RECORDED, RECORDED_TYPE);
    await expect(
      exportArchive(readOnlyClient(client, "preparing a preview"), INVOICES),
    ).rejects.toMatchObject({ kind: "blocked" });
    expect(client.calls).toEqual([]);
  });

  it.each([
    [{ ...INVOICES, from: "2026-11-01" }, "from is after to"],
    [{ ...INVOICES, limit: 0 }, "limit"],
    [{ ...INVOICES, limit: 1001 }, "limit"],
    [{ ...INVOICES, subject: "vouchers", contactId: 1 } as const, "contactId"],
    [{ ...INVOICES, minAmount: "10" }, "minAmount"],
  ] as const)("refuses invalid arguments locally (%#)", async (params, text) => {
    const client = zipClient("/Export/invoiceZip", RECORDED);
    const error = await exportArchive(tierScopedClient(client, "write"), params).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ kind: "validation" });
    expect((error as Error).message).toContain(text);
    expect(client.calls).toEqual([]);
  });

  it("asks for the archive with a size cap", async () => {
    const client = zipClient("/Export/invoiceZip", RECORDED, RECORDED_TYPE);
    let maxBytes: number | undefined;
    await exportArchive(
      {
        request: (request) => client.request(request),
        list: (...args) => client.list(...args),
        listAll: (...args) => client.listAll(...args),
        download: (request) => {
          maxBytes = request.maxBytes;
          return client.download(request);
        },
      },
      INVOICES,
    );
    expect(maxBytes).toBe(MAX_ARCHIVE_BYTES);
  });
});

describe("helpers", () => {
  it("parses media types leniently", () => {
    expect(mediaType("application/zip; charset=UTF-8'")).toBe("application/zip");
    expect(mediaType(" Application/ZIP ")).toBe("application/zip");
    expect(mediaType("'application/zip'")).toBe("application/zip");
    expect(mediaType(undefined)).toBeUndefined();
    expect(mediaType("")).toBeUndefined();
  });

  it("recognizes draft entries by the label after the kind", () => {
    expect(isDraftEntry({ name: "2026-10-09_Rechnung(Entwurf)__00112233.pdf" })).toBe(true);
    expect(isDraftEntry({ name: "x/2026-10-09_Beleg(Entwurf)_Kaffee_0022.pdf" })).toBe(true);
    expect(isDraftEntry({ name: "2026-10-05_Rechnung_RE-1000_0123.pdf" })).toBe(false);
    // A parenthesis in a voucher's description is not a draft label.
    expect(isDraftEntry({ name: "2026-10-05_Beleg_Kaffee (Bio)_0123.pdf" })).toBe(false);
  });

  it("names the file from our own values", () => {
    expect(archiveFilename(INVOICES)).toBe("invoices_2026-10-01_2026-10-31.zip");
  });
});
