import { describe, expect, it } from "vitest";

import {
  ARCHIVE_TIMEOUT_MS,
  archiveFilename,
  type ArchiveParams,
  archiveQuery,
  DEFAULT_ARCHIVE_DOCUMENTS,
  exportArchive,
  isDraftEntry,
  isPlaceholderEntry,
  MAX_ARCHIVE_BYTES,
  mayBeTruncated,
  mediaType,
} from "../../../../src/domain/exports/archive.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { resolveGetSafety } from "../../../../src/sevdesk/paths.js";
import { readOnlyClient, tierScopedClient } from "../../../../src/sevdesk/scoped-client.js";
import type { SevdeskRequest } from "../../../../src/sevdesk/types.js";
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

/** What sevDesk answers when nothing matches (recorded 2026-11-16, D-101): one readme entry. */
const README_ONLY = buildZip([
  {
    name: "readme.txt",
    content: "Es wurden keine Dateien hochgeladen, daher ist diese ZIP leer.",
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
    // An inverted range would come back as sevDesk's empty ZIP ("no document matched").
    [{ ...INVOICES, minAmount: "500", maxAmount: "100" }, "minAmount is above maxAmount"],
    // Compared as decimals, not as text ("100.1" < "99" as strings) or floats.
    [{ ...INVOICES, minAmount: "100.1", maxAmount: "99" }, "minAmount is above maxAmount"],
    [{ ...INVOICES, minAmount: "100.01", maxAmount: "100" }, "minAmount is above maxAmount"],
  ] as const)("refuses invalid arguments locally (%#)", async (params, text) => {
    const client = zipClient("/Export/invoiceZip", RECORDED);
    const error = await exportArchive(tierScopedClient(client, "write"), params).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ kind: "validation" });
    expect((error as Error).message).toContain(text);
    expect(client.calls).toEqual([]);
  });

  it("accepts a range of one amount: the bounds are inclusive (D-101)", async () => {
    const client = zipClient("/Export/voucherZip", RECORDED, RECORDED_TYPE);
    await exportArchive(tierScopedClient(client, "write"), {
      ...INVOICES,
      subject: "vouchers",
      minAmount: "123.4",
      maxAmount: "123.40",
    });
    expect(client.writes()[0]?.query).toMatchObject({
      "sevQuery[filter][startAmount]": "123.4",
      "sevQuery[filter][endAmount]": "123.40",
    });
  });

  it("asks for the archive with a size cap and its own, longer time budget", async () => {
    const client = zipClient("/Export/invoiceZip", RECORDED, RECORDED_TYPE);
    const seen: SevdeskRequest[] = [];
    await exportArchive(
      {
        request: (request) => client.request(request),
        list: (...args) => client.list(...args),
        listAll: (...args) => client.listAll(...args),
        download: (request) => {
          seen.push(request);
          return client.download(request);
        },
      },
      INVOICES,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.maxBytes).toBe(MAX_ARCHIVE_BYTES);
    expect(seen[0]?.timeoutMs).toBe(ARCHIVE_TIMEOUT_MS);
    expect(ARCHIVE_TIMEOUT_MS).toBe(300_000);
  });

  it("sends the invoice amount filter, now recorded (bounds inclusive, decimals)", async () => {
    const client = zipClient("/Export/invoiceZip", RECORDED, RECORDED_TYPE);
    await exportArchive(tierScopedClient(client, "write"), {
      ...INVOICES,
      minAmount: "99.99",
      maxAmount: "100.01",
    });
    expect(client.writes()[0]?.query).toMatchObject({
      "sevQuery[filter][startAmount]": "99.99",
      "sevQuery[filter][endAmount]": "100.01",
    });
  });

  it("treats sevDesk's readme-only ZIP as empty: no document is counted", async () => {
    const client = zipClient("/Export/voucherZip", README_ONLY, RECORDED_TYPE);

    const archive = await exportArchive(tierScopedClient(client, "write"), {
      ...INVOICES,
      subject: "vouchers",
    });

    expect(archive).toMatchObject({ entries: 0, pdfEntries: 0, draftEntries: 0 });
  });

  it("never counts the readme next to documents", async () => {
    const mixed = buildZip([
      { name: "readme.txt", content: "x" },
      { name: "2026-10-05_Rechnung_RE-1000_01.pdf", content: pdfBytes("1") },
    ]);
    const client = zipClient("/Export/invoiceZip", mixed, RECORDED_TYPE);
    await expect(exportArchive(tierScopedClient(client, "write"), INVOICES)).resolves.toMatchObject(
      { entries: 1, pdfEntries: 1 },
    );
  });

  it("turns a timeout into the remedy: a shorter period, nothing saved or changed", async () => {
    const client = new FakeSevdeskClient([
      {
        path: "/Export/invoiceZip",
        response: {
          error: new SevdeskError({ kind: "timeout", message: "sevDesk did not answer." }),
        },
      },
    ]);

    const error = await exportArchive(tierScopedClient(client, "write"), INVOICES).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ kind: "timeout" });
    expect((error as Error).message).toBe(
      "sevDesk did not finish the archive of invoices within 5 minutes (it renders every PDF " +
        "first). Nothing changed in sevDesk and nothing was saved: export a shorter period, for " +
        "example one month, or fewer documents.",
    );
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
    expect(isDraftEntry({ name: "2026-10-09_Rechnung(ENTWURF)__00112233.pdf" })).toBe(true);
    expect(isDraftEntry({ name: "2026-10-05_Rechnung_RE-1000_0123.pdf" })).toBe(false);
    // A parenthesis in a voucher's description is not a draft label.
    expect(isDraftEntry({ name: "2026-10-05_Beleg_Kaffee (Bio)_0123.pdf" })).toBe(false);
  });

  it.each([
    "2026-10-09_Rechnung(Storniert)__00112233.pdf",
    "2026-10-09_Rechnung(Storno)_RE-1000_00112233.pdf",
    "2026-10-09_Beleg(Bezahlt)_Kaffee_0022.pdf",
    "2026-10-09_Rechnung(Entwurf-alt)__00112233.pdf",
  ])("never counts another label in the draft's place as a draft: %s", (name) => {
    // Only "(Entwurf)" was recorded; the result advises removing drafts, which must never hit
    // a document such as a cancellation the tax audit needs.
    expect(isDraftEntry({ name })).toBe(false);
  });

  it("counts only the entries labelled as drafts", async () => {
    const zip = buildZip([
      { name: "2026-10-09_Rechnung(Entwurf)__0011.pdf", content: pdfBytes("1") },
      { name: "2026-10-10_Rechnung(Storniert)__0022.pdf", content: pdfBytes("2") },
    ]);
    const client = zipClient("/Export/invoiceZip", zip, RECORDED_TYPE);
    await expect(exportArchive(tierScopedClient(client, "write"), INVOICES)).resolves.toMatchObject(
      { entries: 2, draftEntries: 1 },
    );
  });

  it("recognizes sevDesk's placeholder only at the top of the ZIP", () => {
    expect(isPlaceholderEntry({ name: "readme.txt" })).toBe(true);
    expect(isPlaceholderEntry({ name: "README.TXT" })).toBe(true);
    expect(isPlaceholderEntry({ name: "ordner/readme.txt" })).toBe(false);
    expect(isPlaceholderEntry({ name: "2026-10-05_Beleg_readme.txt_01.pdf" })).toBe(false);
  });

  it("names the file from our own values", () => {
    expect(archiveFilename(INVOICES)).toBe("invoices_2026-10-01_2026-10-31.zip");
  });

  it.each([
    // An archive cut at the limit can hold a few files less (D-101: one invoice fewer than the
    // list), so a count within 2 % of the limit (at least 1) counts as possibly cut.
    [0, 1, false],
    [1, 1, true],
    [1, 2, true],
    [999, 1000, true],
    [980, 1000, true],
    [979, 1000, false],
    [490, 500, true],
    [489, 500, false],
    [3, 500, false],
  ])("treats %i files for a limit of %i as possibly cut: %s", (entries, limit, expected) => {
    expect(mayBeTruncated(entries, limit)).toBe(expected);
  });

  it("asks for a default that fits the time and size budgets at the recorded rates", () => {
    // D-101: 63 s for 130 invoices, and 138 KB (up to about 190 KB) per rendered invoice.
    const secondsPerInvoice = 63 / 130;
    const bytesPerInvoice = 190_000;
    expect(DEFAULT_ARCHIVE_DOCUMENTS * secondsPerInvoice * 1000).toBeLessThan(ARCHIVE_TIMEOUT_MS);
    expect(DEFAULT_ARCHIVE_DOCUMENTS * bytesPerInvoice).toBeLessThan(MAX_ARCHIVE_BYTES);
  });
});
