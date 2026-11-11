import { deflateRawSync, deflateSync } from "node:zlib";

import { AFRelationship, PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseEInvoice } from "../../../../src/domain/einvoice/parse.js";
import { extractEInvoiceXml } from "../../../../src/domain/einvoice/pdf-attachment.js";
import {
  MAX_PDF_LOAD_INFLATED_BYTES,
  withPdfLoadBudget,
} from "../../../../src/domain/einvoice/pdf-load-guard.js";
import { einvoiceFixture, validationMessage } from "./helpers.js";

const MIB = 1024 * 1024;

/**
 * A minimal PDF whose object 3 is a stream with the given dictionary entries and data: built by
 * hand, because pdf-lib would not write a hostile object stream.
 */
function pdfWithStream(dictionary: string, data: Uint8Array, extraObjects = ""): Uint8Array {
  const head = Buffer.from(
    "%PDF-1.7\n" +
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n" +
      extraObjects +
      `3 0 obj\n<< ${dictionary} /Length ${String(data.byteLength)} >>\nstream\n`,
    "latin1",
  );
  const tail = Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
  return new Uint8Array(Buffer.concat([head, data, tail]));
}

/** `size` bytes of spaces, deflated: about 1000:1. */
function bomb(size: number): Uint8Array {
  return deflateSync(Buffer.alloc(size, 0x20));
}

const OBJECT_STREAM = "/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode";
const XREF_STREAM = "/Type /XRef /Size 4 /W [1 2 1] /Filter /FlateDecode";

beforeEach(() => {
  // pdf-lib reports objects it could not parse (here: the refused streams) on console.warn.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function refused(bytes: Uint8Array, limit = MIB): Promise<string> {
  return validationMessage(extractEInvoiceXml(bytes, { maxLoadInflatedBytes: limit }));
}

describe("PDF load budget (object and cross-reference streams)", () => {
  it("refuses an object stream bomb before pdf-lib decodes it", async () => {
    const bytes = pdfWithStream(OBJECT_STREAM, bomb(2 * MIB));
    expect(bytes.byteLength).toBeLessThan(16 * 1024);
    expect(await refused(bytes)).toBe(
      'The PDF\'s internal structure decompresses to more than 1048576 bytes (a "zip bomb"), ' +
        "so it is not read. Nothing was sent to sevDesk.",
    );
  });

  it("refuses a zlib/raw-deflate polyglot that pdf-lib would inflate as a bomb", async () => {
    // A zlib header with an invalid window size (zlib refuses it, pdf-lib ignores it). Raw
    // deflate would read it as a tiny stored block and a final empty block; pdf-lib reads a
    // stored block of 0xFFE3 bytes followed by the bomb. Found by the second review of M4.
    const head = Buffer.from([0x88, 0x1c, 0x00, 0xe3, 0xff, 0x1c, 0x00]);
    const stored = Buffer.alloc(0xffe3, 0x20);
    Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff]).copy(stored, 33 - 7);
    const payload = Buffer.concat([head, stored, deflateRawSync(Buffer.alloc(8 * MIB, 0x20))]);
    expect(await refused(pdfWithStream(OBJECT_STREAM, payload))).toContain(
      "internal structure is damaged",
    );
  });

  it("still reads a Flate stream without its checksum tail", async () => {
    const complete = deflateSync(Buffer.from("1 0 << /Type /Catalog >>", "latin1"));
    const withoutChecksum = complete.subarray(0, complete.byteLength - 4);
    await expect(
      extractEInvoiceXml(pdfWithStream(OBJECT_STREAM, withoutChecksum), {
        maxLoadInflatedBytes: MIB,
      }),
    ).rejects.not.toThrow(/damaged|zip bomb/);
  });

  it("refuses a cross-reference stream bomb", async () => {
    expect(await refused(pdfWithStream(XREF_STREAM, bomb(2 * MIB)))).toContain("zip bomb");
  });

  it(`refuses a bomb above the default ${String(MAX_PDF_LOAD_INFLATED_BYTES)} bytes end to end`, async () => {
    const bytes = pdfWithStream(OBJECT_STREAM, bomb(MAX_PDF_LOAD_INFLATED_BYTES + MIB));
    expect(bytes.byteLength).toBeLessThan(256 * 1024);
    expect(await validationMessage(parseEInvoice(bytes))).toContain(
      `more than ${String(MAX_PDF_LOAD_INFLATED_BYTES)} bytes`,
    );
  });

  it("sees through name escapes (/Fl#61teDecode) as pdf-lib does", async () => {
    const dictionary = "/Type /Obj#53tm /N 1 /First 4 /Filter /Fl#61teDecode";
    expect(await refused(pdfWithStream(dictionary, bomb(2 * MIB)))).toContain("zip bomb");
  });

  it("charges all streams of one load to one budget", async () => {
    const first = deflateSync(Buffer.alloc(700 * 1024, 0x20));
    const extra =
      `4 0 obj\n<< ${OBJECT_STREAM} /Length ${String(first.byteLength)} >>\nstream\n` +
      `${Buffer.from(first).toString("latin1")}\nendstream\nendobj\n`;
    const bytes = pdfWithStream(OBJECT_STREAM, deflateSync(Buffer.alloc(700 * 1024, 0x20)), extra);
    expect(await refused(bytes)).toContain("zip bomb");
  });

  it("refuses unfiltered streams beyond the budget, other filters and damaged data", async () => {
    expect(
      await refused(pdfWithStream("/Type /ObjStm /N 1 /First 4", Buffer.alloc(2 * MIB, 0x20))),
    ).toContain("zip bomb");
    expect(
      await refused(
        pdfWithStream("/Type /ObjStm /N 1 /First 4 /Filter /LZWDecode", Buffer.from("x")),
      ),
    ).toContain("does not read");
    expect(
      await refused(
        pdfWithStream(
          "/Type /ObjStm /N 1 /First 4 /Filter [/FlateDecode /FlateDecode]",
          bomb(1024),
        ),
      ),
    ).toContain("does not read");
    expect(
      await refused(
        pdfWithStream(
          "/Type /ObjStm /N 1 /First 4 /Filter 9 0 R",
          Buffer.from("x"),
          "9 0 obj\n42\nendobj\n",
        ),
      ),
    ).toContain("does not read");
    expect(await refused(pdfWithStream(OBJECT_STREAM, Buffer.from("not deflate data")))).toContain(
      "damaged",
    );
  });

  it("loads PDFs with object streams within the budget", async () => {
    const document = await PDFDocument.create();
    document.addPage();
    await document.attach(einvoiceFixture("generated/cii-en16931-invoice.xml"), "factur-x.xml", {
      mimeType: "text/xml",
      afRelationship: AFRelationship.Alternative,
    });
    const bytes = await document.save({ useObjectStreams: true });
    expect(new TextDecoder("latin1").decode(bytes)).toContain("/ObjStm");
    const parsed = await parseEInvoice(bytes);
    expect(parsed).toMatchObject({ container: "pdf", attachmentName: "factur-x.xml" });
  });

  it("passes other errors of the load through and keeps loads apart", async () => {
    await expect(withPdfLoadBudget(() => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    const [small, large] = await Promise.allSettled([
      extractEInvoiceXml(pdfWithStream(OBJECT_STREAM, bomb(2 * MIB)), {
        maxLoadInflatedBytes: MIB,
      }),
      extractEInvoiceXml(pdfWithStream(OBJECT_STREAM, bomb(2 * MIB)), {
        maxLoadInflatedBytes: 4 * MIB,
      }),
    ]);
    expect(small.status).toBe("rejected");
    expect(String((small as PromiseRejectedResult).reason)).toContain("zip bomb");
    // Within its own budget the stream is decoded; the hand-built PDF then has no attachment.
    expect(String((large as PromiseRejectedResult).reason)).toContain("no embedded e-invoice XML");
  });
});

describe("PDF structure counts (security review 2026-11, wave 2)", () => {
  it.each([
    [
      "a huge /Size with zero-width fields",
      "/Type /XRef /Size 1000000000 /W [0 0 0]",
      "cross-reference",
    ],
    ["more entries than the data holds", "/Type /XRef /Size 10000 /W [1 2 1]", "cross-reference"],
    [
      "an /Index that declares too many",
      "/Type /XRef /Size 4 /Index [0 900000] /W [1 2 1]",
      "cross-reference",
    ],
    ["field widths out of range", "/Type /XRef /Size 1 /W [1 2000000 1]", "cross-reference"],
    ["more objects than the data holds", "/Type /ObjStm /N 100000 /First 4", "object"],
  ])("refuses %s before pdf-lib loops over it", async (_label, dictionary, what) => {
    const bytes = pdfWithStream(dictionary, Buffer.from("1 0 2 0 "));
    expect(bytes.byteLength).toBeLessThan(1024);
    expect(await refused(bytes)).toContain(`The PDF's ${what} stream is malformed`);
  });

  it("caps the entries of all streams together", async () => {
    // 3 streams of 80,000 well-formed entries each: every one fits its data, together too many.
    const width = 4;
    const stream = (n: number) =>
      `${String(n)} 0 obj\n<< /Type /XRef /Size 80000 /W [1 2 1] /Length ${String(80_000 * width)} >>\nstream\n` +
      `${"\u0001\u0000\u0000\u0000".repeat(80_000)}\nendstream\nendobj\n`;
    const bytes = pdfWithStream(
      "/Type /XRef /Size 80000 /W [1 2 1]",
      Buffer.alloc(80_000 * width, 1),
      stream(4) + stream(5),
    );
    expect(await refused(bytes, 64 * MIB)).toContain(
      "declares more internal objects than this server reads",
    );
  });
});
