import { describe, expect, it } from "vitest";

import {
  checkCsvPeriod,
  countCsvRows,
  CSV_CELL_MAX_BYTES,
  CSV_DATE_COLUMNS,
  CSV_EXPORT_KINDS,
  CSV_EXPORTS,
  CSV_FILTER_DATE_FORMAT,
  csvExportQuery,
  csvFilename,
  csvFilterDate,
  exportCsv,
  MAX_CSV_BYTES,
  scanCsvColumn,
} from "../../../../src/domain/exports/csv.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { FakeSevdeskClient } from "../../../helpers/fake-client.js";

const BOM = [0xef, 0xbb, 0xbf];
/** As the live probe saw it: UTF-8 with BOM, `;`, quoted German header, LF. */
export function sampleCsv(rows: readonly string[]): Uint8Array {
  const text = [`"Rechnungsnummer";"Rechnungs-Datum";"Kunde";"Betrag"`, ...rows].join("\n") + "\n";
  return new Uint8Array([...BOM, ...new TextEncoder().encode(text)]);
}

describe("csvExportQuery", () => {
  it("flattens sevQuery into bracket keys and asks for the raw file", () => {
    expect(
      csvExportQuery({ kind: "invoices", from: "2026-01-01", to: "2026-01-31", limit: 500 }),
    ).toEqual({
      download: "true",
      "sevQuery[objectName]": "SevQuery",
      "sevQuery[modelName]": "Invoice",
      "sevQuery[limit]": 500,
      "sevQuery[filter][startDate]": Date.parse("2026-01-01T00:00:00+01:00") / 1000,
      "sevQuery[filter][endDate]": Date.parse("2026-02-01T00:00:00+01:00") / 1000 - 1,
    });
    expect(csvExportQuery({ kind: "contacts", limit: 10 })).toEqual({
      download: "true",
      "sevQuery[objectName]": "SevQuery",
      "sevQuery[modelName]": "Contact",
      "sevQuery[limit]": 10,
    });
  });

  it("has one endpoint per kind", () => {
    expect(
      CSV_EXPORT_KINDS.map((kind) => [CSV_EXPORTS[kind].path, CSV_EXPORTS[kind].modelName]),
    ).toEqual([
      ["/Export/invoiceCsv", "Invoice"],
      ["/Export/creditNoteCsv", "CreditNote"],
      ["/Export/voucherListCsv", "Voucher"],
      ["/Export/transactionsCsv", "CheckAccountTransaction"],
      ["/Export/contactListCsv", "Contact"],
    ]);
  });
});

describe("exportCsv", () => {
  it("keeps the bytes as sent and counts the data rows", async () => {
    const bytes = sampleCsv([
      `"RE-1";"01.01.2026";"Musterfirma GmbH";"119,00"`,
      `"RE-2";"02.01.2026";"A ""B"" C";"5,00"`,
    ]);
    const client = new FakeSevdeskClient([
      { path: "/Export/invoiceCsv", response: { bytes, contentType: "text/csv; charset=UTF-8" } },
    ]);

    const file = await exportCsv(client, {
      kind: "invoices",
      from: "2026-01-01",
      to: "2026-01-31",
      limit: 1000,
    });

    expect(file).toEqual({
      bytes,
      contentType: "text/csv; charset=UTF-8",
      bom: true,
      rows: 2,
      periodCheck: {
        column: "Rechnungs-Datum",
        rowsOutsidePeriod: 0,
        rowsUnchecked: 0,
        verified: true,
      },
    });
    const call = client.callsTo("/Export/invoiceCsv")[0];
    expect(call).toMatchObject({ operation: "download", method: "GET", sideEffect: false });
    expect(client.writes()).toEqual([]);
  });

  it("decodes the JSON form with base64 content", async () => {
    const csv = `"Name";"Ort"\n"Musterfirma GmbH";"Musterstadt"\n`;
    const json = JSON.stringify({
      objects: {
        filename: "contacts.csv",
        mimetype: "text/csv",
        base64Encoded: true,
        content: Buffer.from(csv).toString("base64"),
      },
    });
    const plain = JSON.stringify({ objects: [{ content: csv, base64Encoded: false }] });
    const client = new FakeSevdeskClient([
      {
        path: "/Export/contactListCsv",
        response: { bytes: new TextEncoder().encode(json), contentType: "application/json" },
      },
      {
        path: "/Export/transactionsCsv",
        response: { bytes: new TextEncoder().encode(plain) },
      },
    ]);

    const contacts = await exportCsv(client, { kind: "contacts", limit: 10 });
    expect(new TextDecoder().decode(contacts.bytes)).toBe(csv);
    expect(contacts).toMatchObject({ contentType: "text/csv", rows: 1, bom: false });
    const transactions = await exportCsv(client, { kind: "transactions", limit: 10 });
    expect(transactions.rows).toBe(1);
    expect(transactions.contentType).toBeUndefined();
  });

  it.each([
    ["not json at all {", "application/json"],
    [JSON.stringify({ objects: null }), "application/json"],
    [JSON.stringify({ objects: { content: 5 } }), "application/json"],
    [JSON.stringify({ objects: { content: "$$$", base64Encoded: "1" } }), "application/json"],
  ])("refuses an unexpected JSON answer: %s", async (body, contentType) => {
    const client = new FakeSevdeskClient([
      {
        path: "/Export/voucherListCsv",
        response: { bytes: new TextEncoder().encode(body), contentType },
      },
    ]);
    await expect(exportCsv(client, { kind: "vouchers", limit: 1 })).rejects.toMatchObject({
      kind: "unexpected_response",
    });
  });

  it("refuses dates on contacts, bad limits and reversed ranges before sending", async () => {
    const client = new FakeSevdeskClient([]);
    await expect(
      exportCsv(client, { kind: "contacts", from: "2026-01-01", limit: 1 }),
    ).rejects.toThrow("takes no date range");
    await expect(exportCsv(client, { kind: "invoices", limit: 0 })).rejects.toThrow("limit");
    await expect(exportCsv(client, { kind: "invoices", limit: 1001 })).rejects.toBeInstanceOf(
      SevdeskError,
    );
    await expect(
      exportCsv(client, { kind: "invoices", from: "2026-02-01", to: "2026-01-01", limit: 1 }),
    ).rejects.toThrow("from is after to");
    expect(client.calls).toEqual([]);
  });

  it("caps the body at MAX_CSV_BYTES", async () => {
    const seen: unknown[] = [];
    class Recording extends FakeSevdeskClient {
      override download(request: Parameters<FakeSevdeskClient["download"]>[0]) {
        seen.push(request.maxBytes);
        return super.download(request);
      }
    }
    const client = new Recording([
      {
        path: "/Export/creditNoteCsv",
        response: { bytes: sampleCsv([]), contentType: "text/csv" },
      },
    ]);

    await exportCsv(client, { kind: "credit_notes", limit: 5 });

    expect(seen).toEqual([MAX_CSV_BYTES]);
    expect(MAX_CSV_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("the date filter", () => {
  it("is sent as Unix seconds (verified for invoiceCsv), the other forms kept in one place", () => {
    expect(CSV_FILTER_DATE_FORMAT).toBe("unix");
    expect(csvFilterDate("2026-01-31", "end")).toBe(
      Date.parse("2026-02-01T00:00:00+01:00") / 1000 - 1,
    );
    expect(csvFilterDate("2026-01-31", "start", "iso")).toBe("2026-01-31");
    expect(csvFilterDate("2026-01-31", "start", "german")).toBe("31.01.2026");
  });
});

describe("checkCsvPeriod", () => {
  const encode = (text: string) =>
    new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
  const range = { kind: "invoices" as const, from: "2026-01-01", to: "2026-01-31" };

  it("verifies a file whose dates all lie in the range", () => {
    const file = encode(
      `"Nr";"Rechnungs-Datum";"Betrag"\n"RE-1";"05.01.2026";"1,00"\n"RE-2";"31.01.2026 12:00";"2,00"\n`,
    );
    expect(checkCsvPeriod(file, range)).toEqual({
      column: "Rechnungs-Datum",
      rowsOutsidePeriod: 0,
      rowsUnchecked: 0,
      verified: true,
    });
  });

  it("counts rows outside the range and rows without a readable date", () => {
    const file = encode(
      `"Nr";"rechnungs-datum "\n"RE-1";"2025-12-31"\n"RE-2";"01.02.2026"\n"RE-3";""\n"RE-4";"15.01.2026"\n`,
    );
    expect(checkCsvPeriod(file, range)).toEqual({
      column: "Rechnungs-Datum",
      rowsOutsidePeriod: 2,
      rowsUnchecked: 1,
      verified: false,
    });
    expect(checkCsvPeriod(file, { kind: "invoices", to: "2026-01-31" }).rowsOutsidePeriod).toBe(1);
  });

  it("reports every row as unchecked without a known date column", () => {
    const file = new TextEncoder().encode(`"Nr";"Wann"\n"1";"05.01.2026"\n`);
    expect(checkCsvPeriod(file, { kind: "credit_notes", from: "2026-01-01" })).toEqual({
      rowsOutsidePeriod: 0,
      rowsUnchecked: 1,
      verified: false,
    });
    expect(CSV_DATE_COLUMNS.transactions[0]).toBe("Bezahldatum");
  });

  // Keep the near-20 MiB regression: both scans need headroom under full-suite/coverage load.
  // Give only this test 15 seconds; shrinking the file would lose the size regression.
  it("checks a large file with long text columns, quoted line breaks and separators", () => {
    // 20,000 rows of about 1 KiB each, close to the largest file accepted: only the date column
    // is kept while it is read.
    const filler = `"${'Leistung; mit ""Zitat""\nund Zeilenumbruch '.repeat(24)}"`;
    const lines = [`"Nr";"Beschreibung";"Rechnungs-Datum";"Betrag"`];
    for (let index = 0; index < 20_000; index += 1) {
      const date = index % 1_000 === 0 ? "01.02.2026" : index % 2_500 === 1 ? "" : "15.01.2026";
      lines.push(`"RE-${String(index)}";${filler};"${date}";"1,00"`);
    }
    const file = new TextEncoder().encode(lines.join("\r\n"));
    expect(file.length).toBeGreaterThan(19 * 1024 * 1024);
    expect(file.length).toBeLessThanOrEqual(MAX_CSV_BYTES);

    expect(checkCsvPeriod(file, range)).toEqual({
      column: "Rechnungs-Datum",
      rowsOutsidePeriod: 20,
      rowsUnchecked: 8,
      verified: false,
    });
    expect(countCsvRows(file)).toBe(20_000);
  }, 15_000);
});

describe("scanCsvColumn", () => {
  /** The header and the cells of column `index` (`null` for a record without that field). */
  const scan = (text: string, index: number | undefined) => {
    const headers: string[][] = [];
    const cells: (string | null)[] = [];
    scanCsvColumn(
      new TextEncoder().encode(text),
      (header) => {
        headers.push([...header]);
        return index;
      },
      (cell) => cells.push(cell ?? null),
    );
    return { header: headers[0], cells };
  };

  it("reads quotes, escaped quotes, separators and line breaks inside fields", () => {
    const text = `"a";"b ""c"";d"\r\n"multi\nline";x\n\n"last"`;
    expect(scan(text, 0)).toEqual({ header: ["a", 'b "c";d'], cells: ["multi\nline", "last"] });
    // The last record has one field only.
    expect(scan(text, 1)).toEqual({ header: ["a", 'b "c";d'], cells: ["x", null] });
    expect(scan(text, undefined).cells).toEqual([null, null]);
  });

  it("skips blank lines (also before the header), ignores a byte order mark and CR", () => {
    expect(scan(`\n\r\n"Nr";"Datum"\r\n\r\n"1";"05.01.2026"\r\n`, 1)).toEqual({
      header: ["Nr", "Datum"],
      cells: ["05.01.2026"],
    });
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(`"Ä";ö\nü;ß`)]);
    const cells: (string | undefined)[] = [];
    let header: readonly string[] = [];
    scanCsvColumn(
      withBom,
      (names) => {
        header = [...names];
        return 1;
      },
      (cell) => cells.push(cell),
    );
    expect(header).toEqual(["Ä", "ö"]);
    expect(cells).toEqual(["ß"]);
  });

  it("calls back once per data record, none for an empty file or a header alone", () => {
    expect(scan("", 0)).toEqual({ header: undefined, cells: [] });
    expect(scan(`"a";"b"\n`, 0)).toEqual({ header: ["a", "b"], cells: [] });
    expect(scan(`a;b\n1;2\n;\n3;4`, 1).cells).toEqual(["2", "", "4"]);
  });

  it("keeps only the first bytes of an overlong cell, so no table of the file is held", () => {
    const long = "x".repeat(CSV_CELL_MAX_BYTES + 5_000);
    const { header, cells } = scan(`"${long}";"Datum"\n"1";"${long}"\n"2";"05.01.2026"`, 1);
    expect(header?.[0]).toHaveLength(CSV_CELL_MAX_BYTES);
    expect(header?.[1]).toBe("Datum");
    expect(cells.map((cell) => cell?.length)).toEqual([CSV_CELL_MAX_BYTES, 10]);
  });
});

describe("countCsvRows and csvFilename", () => {
  it("counts records outside quotes, CRLF once, a last line without break", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(countCsvRows(encode(""))).toBe(0);
    expect(countCsvRows(encode(`"a";"b"\n`))).toBe(0);
    expect(countCsvRows(encode(`"a"\r\n"1"\r\n"2"`))).toBe(2);
    expect(countCsvRows(encode(`"a"\n"multi\nline"\n"3"\n`))).toBe(2);
  });

  it("names files from our own values", () => {
    expect(csvFilename({ kind: "invoices", from: "2026-01-01", to: "2026-01-31", limit: 1 })).toBe(
      "invoices_2026-01-01_2026-01-31.csv",
    );
    expect(csvFilename({ kind: "contacts", limit: 1 })).toBe("contacts.csv");
  });
});
