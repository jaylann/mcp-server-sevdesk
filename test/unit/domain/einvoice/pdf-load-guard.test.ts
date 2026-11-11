import { deflateRawSync, deflateSync } from "node:zlib";

import {
  AFRelationship,
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectParser,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseEInvoice } from "../../../../src/domain/einvoice/parse.js";
import { extractEInvoiceXml } from "../../../../src/domain/einvoice/pdf-attachment.js";
import {
  MAX_PDF_LOAD_INFLATED_BYTES,
  MAX_PDF_LOAD_VALUES,
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

/**
 * `size` bytes, deflated (about 1000:1): a well-formed object stream of one object (`null` at
 * offset 0, header `9 0 `, `/First 4`) and spaces behind it, so only its size can be refused.
 */
function bomb(size: number): Uint8Array {
  const data = Buffer.alloc(size, 0x20);
  data.write("9 0 null", "latin1");
  return deflateSync(data);
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
    const first = bomb(700 * 1024);
    const extra =
      `4 0 obj\n<< ${OBJECT_STREAM} /Length ${String(first.byteLength)} >>\nstream\n` +
      `${Buffer.from(first).toString("latin1")}\nendstream\nendobj\n`;
    // Each stream alone fits the budget and loads.
    expect(await refused(pdfWithStream(OBJECT_STREAM, bomb(700 * 1024)))).toContain(
      "no embedded e-invoice XML",
    );
    const bytes = pdfWithStream(OBJECT_STREAM, bomb(700 * 1024), extra);
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

/** A minimal PDF with further indirect objects (as text) and junk between them and the trailer. */
function pdfWith(objects: string, junk = ""): Uint8Array {
  return new Uint8Array(
    Buffer.from(
      "%PDF-1.7\n" +
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
        "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n" +
        objects +
        junk +
        "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
      "latin1",
    ),
  );
}

/** A PDF with one unfiltered object stream: `header` (object number and offset pairs), `body`. */
function pdfWithObjectStream(
  count: number,
  header: string,
  body: string,
  first: number | null = header.length,
): Uint8Array {
  const firstEntry = first === null ? "" : ` /First ${String(first)}`;
  return pdfWithStream(
    `/Type /ObjStm /N ${String(count)}${firstEntry}`,
    Buffer.from(header + body, "latin1"),
  );
}

const NOT_AN_EINVOICE = "no embedded e-invoice XML";
const TOO_MANY_VALUES = "The PDF's internal structure holds more values than this server reads";
const TOO_MUCH_WORK = "The PDF is damaged in a way that takes too much work to read";
const TOO_LONG = "The PDF holds a name, number or string longer than this server reads";

async function refusedWithValues(bytes: Uint8Array, maxLoadValues: number): Promise<string> {
  return validationMessage(extractEInvoiceXml(bytes, { maxLoadValues }));
}

describe("object stream headers (review 2026-11, round 3)", () => {
  it("refuses object numbers that share one offset", async () => {
    // pdf-lib parsed and kept the array once per header pair: 4,000 pairs on one array of 20,000
    // numbers were a 66 KiB file, 19 s and 2.8 GiB of heap.
    const bytes = pdfWithObjectStream(4, "10 0 11 0 12 0 13 0 ", "[0 0 0]");
    expect(await refused(bytes)).toBe(
      "The PDF's object stream is malformed. Nothing was sent to sevDesk.",
    );
  });

  it.each<[string, Uint8Array]>([
    ["offsets that go back", pdfWithObjectStream(2, "10 5 11 0 ", "null null")],
    ["an offset behind the data", pdfWithObjectStream(2, "10 0 11 500 ", "null null")],
    ["a header that runs past /First", pdfWithObjectStream(2, "10 0 11 5 ", "null null", 6)],
    ["a /First behind the data", pdfWithObjectStream(2, "10 0 11 5 ", "null null", 900)],
    ["no /First", pdfWithObjectStream(2, "10 0 11 5 ", "null null", null)],
    ["a comment in the header", pdfWithObjectStream(2, "10 0 %c\n11 5 ", "null null")],
    ["a sign in the header", pdfWithObjectStream(2, "10 0 11 +5 ", "null null")],
    ["fewer pairs than /N", pdfWithObjectStream(3, "10 0 11 5 ", "null null 12 9 ")],
  ])("refuses %s", async (_label, bytes) => {
    expect(await refused(bytes)).toContain("The PDF's object stream is malformed");
  });

  it("reads the objects of a well-formed header", async () => {
    const bytes = pdfWithObjectStream(2, "10 0\n11 5\n", "null [1 2 3]");
    const document = await withPdfLoadBudget(() =>
      PDFDocument.load(bytes, { updateMetadata: false }),
    );
    expect(document.context.lookup(PDFRef.of(11), PDFArray).size()).toBe(3);
  });
});

describe("values a load may build (review 2026-11, round 3)", () => {
  /** `depth` arrays inside each other, each with `width` numbers, and an object number on each. */
  function nestedArrays(depth: number, width: number): Uint8Array {
    let header = "";
    let body = "";
    for (let level = 0; level < depth; level += 1) {
      header += `${String(10 + level)} ${String(body.length)} `;
      body += `[${"0 ".repeat(width)}`;
    }
    return pdfWithObjectStream(depth, header, body + "]".repeat(depth));
  }

  it("counts nested arrays that every object number parses again", async () => {
    // Honest, strictly increasing offsets: 40 objects, each parsing all arrays below its own,
    // 17,000 values from 1,700 bytes.
    const bytes = nestedArrays(40, 20);
    expect(bytes.byteLength).toBeLessThan(2500);
    expect(await refusedWithValues(bytes, 2000)).toBe(
      `${TOO_MANY_VALUES}. Nothing was sent to sevDesk.`,
    );
    // Under the real limit of values the steps stop it: far more work than 2,500 bytes explain.
    expect(await refused(bytes)).toContain(TOO_MUCH_WORK);
    // The header as such is well formed: a few small nested arrays load.
    expect(await refused(nestedArrays(4, 3))).toContain(NOT_AN_EINVOICE);
  });

  it("counts one flat array in a plain object and stops parsing there", async () => {
    const bytes = pdfWith(`5 0 obj\n[${"0 ".repeat(5000)}]\nendobj\n`);
    expect(await refused(bytes)).toContain(NOT_AN_EINVOICE);
    // The spy goes on top of the guard's own hook, so the guard has to be installed first.
    await withPdfLoadBudget(() => Promise.resolve());
    const parseObject = vi.spyOn(PDFObjectParser.prototype, "parseObject");
    expect(await refusedWithValues(bytes, 1000)).toContain(TOO_MANY_VALUES);
    // 1,000 values and the one that ran over; pdf-lib does not go on with the other 4,000.
    expect(parseObject.mock.calls.length).toBeLessThan(1010);
  });

  it("counts dictionary values and indirect objects", async () => {
    const objects = Array.from(
      { length: 300 },
      (_, index) => `${String(10 + index)} 0 obj\n<< /A 1 /B (two) /C /Three >>\nendobj\n`,
    ).join("");
    expect(await refusedWithValues(pdfWith(objects), 1000)).toContain(TOO_MANY_VALUES);
    expect(await refusedWithValues(pdfWith(objects), 2000)).toContain(NOT_AN_EINVOICE);
  });

  it(`refuses more than ${String(MAX_PDF_LOAD_VALUES)} values end to end`, async () => {
    const bytes = pdfWith(`5 0 obj\n[${"0 ".repeat(MAX_PDF_LOAD_VALUES + 10)}]\nendobj\n`);
    expect(await validationMessage(parseEInvoice(bytes))).toContain(TOO_MANY_VALUES);
  });

  it("keeps the values of parallel loads apart", async () => {
    const bytes = pdfWith(`5 0 obj\n[${"0 ".repeat(5000)}]\nendobj\n`);
    const [small, large] = await Promise.allSettled([
      extractEInvoiceXml(bytes, { maxLoadValues: 3000 }),
      extractEInvoiceXml(bytes, { maxLoadValues: 6000 }),
    ]);
    expect(String((small as PromiseRejectedResult).reason)).toContain(TOO_MANY_VALUES);
    expect(String((large as PromiseRejectedResult).reason)).toContain(NOT_AN_EINVOICE);
  });
});

describe("parser steps and token lengths (review 2026-11, round 3)", () => {
  // pdf-lib looks for an object header at every byte of junk between two objects. Each of these
  // made that quadratic: 100,000 digits were a 98 KiB file and 68 s of one busy thread.
  it.each<[string, string, string]>([
    ["a long run of blanks", `x${" ".repeat(20_000)}\n`, TOO_MUCH_WORK],
    ["a long run of comment signs", `x${"%".repeat(20_000)}\n`, TOO_MUCH_WORK],
    ["a long run of digits", `x${"1".repeat(20_000)}\n`, TOO_LONG],
  ])("stops at junk with %s", async (_label, junk, reason) => {
    const bytes = pdfWith("5 0 obj\n42\nendobj\n", junk);
    expect(await refused(bytes)).toBe(`${reason}. Nothing was sent to sevDesk.`);
  });

  it("stops at streams without an end that are each searched to the end of the file", async () => {
    const objects = Array.from(
      { length: 1500 },
      (_, index) => `${String(10 + index)} 0 obj\n<< >>\nstream\nendobj\n`,
    ).join("");
    expect(await refused(pdfWith(objects))).toContain(TOO_MUCH_WORK);
  });

  it.each<[string, string]>([
    ["a number", "7".repeat(300)],
    ["a name", `/${"n".repeat(2000)}`],
    ["a literal string", `(${"s".repeat(MIB + 16)})`],
    ["a hex string", `<${"ab".repeat(MIB / 2 + 16)}>`],
  ])("refuses %s that is longer than any real one", async (_label, token) => {
    expect(await refused(pdfWith(`5 0 obj\n[ ${token} ]\nendobj\n`))).toContain(TOO_LONG);
  });

  it("reads long names and strings below the limits unchanged", async () => {
    const name = "n".repeat(1000);
    const text = "s (nested \\) paren) ".repeat(10_000);
    const hex = "0123456789abcdef".repeat(20_000);
    const bytes = pdfWith(`5 0 obj\n[ /${name} (${text}) <${hex}> -0012345.6250 ]\nendobj\n`);
    const document = await withPdfLoadBudget(() =>
      PDFDocument.load(bytes, { updateMetadata: false }),
    );
    const array = document.context.lookup(PDFRef.of(5), PDFArray);
    expect(array.lookup(0, PDFName).decodeText()).toBe(name);
    expect(array.lookup(1, PDFString).asString()).toBe(text);
    expect(array.lookup(2, PDFHexString).asString()).toBe(hex);
    expect(array.lookup(3, PDFNumber).asNumber()).toBe(-12345.625);
  });

  it("loads a larger PDF written by pdf-lib, with and without object streams", async () => {
    const document = await PDFDocument.create();
    for (let page = 0; page < 300; page += 1) document.addPage().drawText(`Page ${String(page)}`);
    await document.attach(einvoiceFixture("generated/cii-en16931-invoice.xml"), "factur-x.xml", {
      mimeType: "text/xml",
      afRelationship: AFRelationship.Alternative,
    });
    for (const useObjectStreams of [true, false]) {
      const parsed = await parseEInvoice(await document.save({ useObjectStreams }));
      expect(parsed).toMatchObject({ container: "pdf", attachmentName: "factur-x.xml" });
    }
  });
});
