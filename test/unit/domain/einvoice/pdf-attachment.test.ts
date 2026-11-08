import { deflateRawSync, deflateSync } from "node:zlib";

import { PDFDocument, PDFHexString, PDFName, type PDFRef, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { MAX_EINVOICE_XML_BYTES } from "../../../../src/domain/einvoice/model.js";
import { extractEInvoiceXml } from "../../../../src/domain/einvoice/pdf-attachment.js";
import { einvoiceFixture, utf8, validationMessage } from "./helpers.js";

interface FileSpec {
  readonly name: string;
  readonly contents: Uint8Array;
  readonly filter?: string;
  readonly predictor?: number;
  /** Write the name only as `/F` (a byte string), not as `/UF`. */
  readonly onlyF?: boolean;
  /** Leave out the `/EF` dictionary. */
  readonly noEmbeddedFile?: boolean;
}

/**
 * A PDF with hand-built file specifications: in the catalog's `/AF` array, in the flat
 * `/EmbeddedFiles` name tree, or in a `/Kids` node that also points back at itself (a cycle).
 */
async function pdfWith(
  files: readonly FileSpec[],
  where: "af" | "names" | "kids-cycle" = "af",
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.addPage();
  const { context, catalog } = document;
  const refs: PDFRef[] = files.map((file) => {
    const stream = context.stream(file.contents, {
      Type: "EmbeddedFile",
      ...(file.filter === undefined ? {} : { Filter: file.filter }),
      ...(file.predictor === undefined ? {} : { DecodeParms: { Predictor: file.predictor } }),
    });
    const spec = context.obj({
      Type: "Filespec",
      F: PDFString.of(file.name),
      ...(file.onlyF === true ? {} : { UF: PDFHexString.fromText(file.name) }),
      ...(file.noEmbeddedFile === true ? {} : { EF: { F: context.register(stream) } }),
    });
    return context.register(spec);
  });
  const pairs = files.flatMap((file, index) => [PDFHexString.fromText(file.name), refs[index]!]);
  if (where === "af") {
    catalog.set(PDFName.of("AF"), context.obj(refs));
  } else if (where === "names") {
    catalog.set(PDFName.of("Names"), context.obj({ EmbeddedFiles: { Names: pairs } }));
  } else {
    const kid = context.obj({ Names: pairs });
    const kidRef = context.register(kid);
    kid.set(PDFName.of("Kids"), context.obj([kidRef]));
    catalog.set(PDFName.of("Names"), context.obj({ EmbeddedFiles: { Kids: [kidRef] } }));
  }
  return document.save({ useObjectStreams: false });
}

const XML = utf8("<a/>");

describe("extractEInvoiceXml", () => {
  it("prefers factur-x.xml, then zugferd-invoice.xml, then xrechnung.xml", async () => {
    const candidates = ["notes.xml", "xrechnung.xml", "ZUGFeRD-invoice.xml", "Factur-X.xml"];
    const files = candidates.map((name) => ({
      name,
      contents: utf8(`<${name.replace(/\W/g, "")}/>`),
    }));
    expect((await extractEInvoiceXml(await pdfWith(files))).name).toBe("Factur-X.xml");
    expect((await extractEInvoiceXml(await pdfWith(files.slice(0, 3)))).name).toBe(
      "ZUGFeRD-invoice.xml",
    );
    expect((await extractEInvoiceXml(await pdfWith(files.slice(0, 2)))).name).toBe("xrechnung.xml");
  });

  it("falls back to the first other XML attachment by name and ignores non-XML files", async () => {
    const attachment = await extractEInvoiceXml(
      await pdfWith([
        { name: "z-data.xml", contents: utf8("<z/>") },
        { name: "Aufmass.pdf", contents: utf8("%PDF-1.7") },
        { name: "dir/a-data.xml", contents: utf8("<a/>") },
      ]),
    );
    expect(attachment).toEqual({ name: "dir/a-data.xml", bytes: utf8("<a/>") });
  });

  it("refuses a PDF whose only attachment is not XML", async () => {
    const message = await validationMessage(
      extractEInvoiceXml(await pdfWith([{ name: "Aufmass.pdf", contents: utf8("%PDF-1.7") }])),
    );
    expect(message).toContain("no embedded e-invoice XML");
  });

  it("finds attachments in the name tree (flat and in a cyclic Kids node)", async () => {
    const file = { name: "factur-x.xml", contents: deflateSync(XML), filter: "FlateDecode" };
    expect((await extractEInvoiceXml(await pdfWith([file], "names"))).bytes).toEqual(XML);
    expect((await extractEInvoiceXml(await pdfWith([file], "kids-cycle"))).bytes).toEqual(XML);
  });

  it("reads byte-string names (/F only) and skips specifications without an embedded file", async () => {
    const attachment = await extractEInvoiceXml(
      await pdfWith([
        { name: "factur-x.xml", contents: XML, noEmbeddedFile: true },
        { name: "xrechnung.xml", contents: XML, onlyF: true },
      ]),
    );
    expect(attachment.name).toBe("xrechnung.xml");
  });

  it("decodes unfiltered streams and raw deflate data", async () => {
    expect(
      (await extractEInvoiceXml(await pdfWith([{ name: "factur-x.xml", contents: XML }]))).bytes,
    ).toEqual(XML);
    const raw = { name: "factur-x.xml", contents: deflateRawSync(XML), filter: "FlateDecode" };
    expect((await extractEInvoiceXml(await pdfWith([raw]))).bytes).toEqual(XML);
  });

  it.each([
    [{ filter: "ASCIIHexDecode", contents: utf8("3C612F3E>") }, "stream encoding"],
    [{ filter: "FlateDecode", contents: deflateSync(XML), predictor: 12 }, "stream encoding"],
    [{ filter: "FlateDecode", contents: utf8("not deflate data") }, "damaged"],
  ])("refuses %o", async (file, expected) => {
    const message = await validationMessage(
      extractEInvoiceXml(await pdfWith([{ name: "factur-x.xml", ...file }])),
    );
    expect(message).toContain(expected);
  });

  it("refuses an unfiltered attachment above the XML limit", async () => {
    const big = new Uint8Array(MAX_EINVOICE_XML_BYTES + 1).fill(0x20);
    const message = await validationMessage(
      extractEInvoiceXml(await pdfWith([{ name: "factur-x.xml", contents: big }])),
    );
    expect(message).toContain("larger than");
  });

  it("refuses bytes that are not a PDF", async () => {
    expect(await validationMessage(extractEInvoiceXml(utf8("%PDF-1.7 garbage")))).toContain(
      "cannot be read as a PDF",
    );
  });

  it("reads the generated ZUGFeRD fixture", async () => {
    const attachment = await extractEInvoiceXml(einvoiceFixture("generated/zugferd-en16931.pdf"));
    expect(attachment.name).toBe("factur-x.xml");
    expect(new TextDecoder().decode(attachment.bytes)).toContain("CrossIndustryInvoice");
  });
});
