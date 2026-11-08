/**
 * Finds the e-invoice XML inside a ZUGFeRD / Factur-X PDF (a PDF/A-3 with the CII XML as an
 * embedded file). Reading uses pdf-lib's object model only (no rendering, no JavaScript, no
 * external references) and treats the PDF as hostile:
 *
 * - Loading is bounded: pdf-lib decodes object and cross-reference streams while it loads, so
 *   the load runs under `withPdfLoadBudget` (`pdf-load-guard.ts`), which refuses those streams
 *   when they decompress beyond 64 MiB in total or use a filter other than FlateDecode.
 * - Embedded files are collected from the catalog's associated files array (`/AF`, PDF/A-3) and
 *   from the `/Names /EmbeddedFiles` name tree (`/Names` pairs and `/Kids`, depth-limited, cycles
 *   ignored), deduplicated.
 * - The attachment is chosen by name, case-insensitively, in this order: `factur-x.xml`
 *   (Factur-X 1.0 / ZUGFeRD 2.1+), `zugferd-invoice.xml` (ZUGFeRD 2.0; ZUGFeRD 1.0 used
 *   `ZUGFeRD-invoice.xml`, recognized later by its root element), `xrechnung.xml` (XRechnung
 *   inside ZUGFeRD 2.1.1+); otherwise the first other `.xml` attachment by name.
 * - The attachment's stream is decoded only when it is unfiltered or `FlateDecode`, with Node's
 *   zlib and an output cap of {@link MAX_EINVOICE_XML_BYTES}, so a compressed attachment cannot
 *   exhaust memory; other filters and predictors are refused.
 * - Encrypted PDFs are refused (the attachment could not be read reliably).
 * - A PDF without any XML attachment is not an e-invoice: the refusal says so and points to
 *   `sevdesk_voucher_create_draft`, which books a plain receipt PDF.
 *
 * Messages are trusted text; attachment names are untrusted and never put into them.
 */
import { inflateRawSync, inflateSync } from "node:zlib";

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFString,
} from "pdf-lib";

import { SevdeskError } from "../../sevdesk/errors.js";
import { MAX_EINVOICE_XML_BYTES } from "./model.js";
import { withPdfLoadBudget } from "./pdf-load-guard.js";

/** The XML found in a PDF. */
export interface PdfAttachment {
  /** The attachment's file name as stored (untrusted; sanitize before showing). */
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Attachment names that carry the invoice, in order of preference (lower case). */
const EINVOICE_ATTACHMENT_NAMES = ["factur-x.xml", "zugferd-invoice.xml", "xrechnung.xml"] as const;

/** Name-tree depth and entry limits (real PDFs have one level and a handful of files). */
const MAX_NAME_TREE_DEPTH = 8;
const MAX_EMBEDDED_FILES = 200;

/** Hint for files that are not e-invoices, shared with the parser's refusals. */
export const PLAIN_RECEIPT_HINT =
  "If it is an ordinary receipt or invoice, create the voucher (Beleg) with " +
  "sevdesk_voucher_create_draft and attach the file instead";

/**
 * Extracts the e-invoice XML from PDF bytes under the rules in the module doc. Throws a local
 * `validation` {@link SevdeskError} when the PDF cannot be read, is encrypted, has no XML
 * attachment, or the attachment cannot be decoded within the limits.
 */
export async function extractEInvoiceXml(
  bytes: Uint8Array,
  options: { readonly maxLoadInflatedBytes?: number } = {},
): Promise<PdfAttachment> {
  let document: PDFDocument;
  try {
    document = await withPdfLoadBudget(
      () =>
        PDFDocument.load(bytes, {
          ignoreEncryption: false,
          updateMetadata: false,
          throwOnInvalidObject: false,
        }),
      options.maxLoadInflatedBytes,
    );
  } catch (error) {
    if (error instanceof SevdeskError) throw error;
    // pdf-lib's EncryptedPDFError is compiled to ES5, so `instanceof` fails; its message is fixed.
    if (error instanceof Error && error.message.includes("is encrypted")) {
      throw pdfRefusal(
        "The PDF is encrypted, so its e-invoice attachment cannot be read. Ask the sender for an " +
          "unencrypted ZUGFeRD/Factur-X PDF or the XRechnung XML",
      );
    }
    throw pdfRefusal("The file cannot be read as a PDF (damaged or not a PDF)");
  }

  let files: EmbeddedFile[];
  try {
    files = embeddedFiles(document);
  } catch {
    // pdf-lib loads damaged files leniently; a missing catalog or broken objects surface here.
    throw pdfRefusal("The file cannot be read as a PDF (damaged or not a PDF)");
  }
  const chosen = chooseAttachment(files);
  if (chosen === undefined) {
    throw pdfRefusal(
      "The PDF has no embedded e-invoice XML (no ZUGFeRD, Factur-X or XRechnung attachment), " +
        `so it is not an e-invoice. ${PLAIN_RECEIPT_HINT}`,
    );
  }
  return { name: chosen.name, bytes: decodeStream(chosen.stream) };
}

interface EmbeddedFile {
  readonly name: string;
  readonly stream: PDFRawStream;
}

function embeddedFiles(document: PDFDocument): EmbeddedFile[] {
  const { catalog, context } = document;
  const specs: PDFDict[] = [];
  const seen = new Set<PDFObject>();
  const remember = (object: PDFObject | undefined): void => {
    if (object === undefined || seen.has(object) || specs.length >= MAX_EMBEDDED_FILES) return;
    seen.add(object);
    const spec = resolve(context, object);
    if (spec instanceof PDFDict && !seen.has(spec)) {
      seen.add(spec);
      specs.push(spec);
    }
  };

  const associated = resolve(context, catalog.get(PDFName.of("AF")));
  if (associated instanceof PDFArray) {
    for (const entry of associated.asArray()) remember(entry);
  }

  const names = resolve(context, catalog.get(PDFName.of("Names")));
  const tree =
    names instanceof PDFDict ? resolve(context, names.get(PDFName.of("EmbeddedFiles"))) : undefined;
  const visited = new Set<PDFObject>();
  const walk = (node: PDFObject | undefined, depth: number): void => {
    if (!(node instanceof PDFDict) || depth > MAX_NAME_TREE_DEPTH || visited.has(node)) return;
    visited.add(node);
    const pairs = resolve(context, node.get(PDFName.of("Names")));
    if (pairs instanceof PDFArray) {
      const items = pairs.asArray();
      for (let index = 1; index < items.length; index += 2) remember(items[index]);
    }
    const kids = resolve(context, node.get(PDFName.of("Kids")));
    if (kids instanceof PDFArray) {
      for (const kid of kids.asArray()) walk(resolve(context, kid), depth + 1);
    }
  };
  walk(tree, 0);

  const files: EmbeddedFile[] = [];
  for (const spec of specs) {
    const name =
      textOf(resolve(context, spec.get(PDFName.of("UF")))) ??
      textOf(resolve(context, spec.get(PDFName.of("F"))));
    const embedded = resolve(context, spec.get(PDFName.of("EF")));
    if (name === undefined || !(embedded instanceof PDFDict)) continue;
    const stream =
      resolve(context, embedded.get(PDFName.of("F"))) ??
      resolve(context, embedded.get(PDFName.of("UF")));
    if (stream instanceof PDFRawStream) files.push({ name, stream });
  }
  return files;
}

function chooseAttachment(files: readonly EmbeddedFile[]): EmbeddedFile | undefined {
  const byName = (name: string): EmbeddedFile | undefined =>
    files.find((file) => baseName(file.name).toLowerCase() === name);
  for (const name of EINVOICE_ATTACHMENT_NAMES) {
    const file = byName(name);
    if (file !== undefined) return file;
  }
  return [...files]
    .filter((file) => baseName(file.name).toLowerCase().endsWith(".xml"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
}

/** Decodes an embedded file stream: unfiltered or FlateDecode, capped at the XML limit. */
function decodeStream(stream: PDFRawStream): Uint8Array {
  const { dict } = stream;
  const { context } = dict;
  const filterObject = resolve(context, dict.get(PDFName.of("Filter")));
  const filters =
    filterObject === undefined
      ? []
      : filterObject instanceof PDFArray
        ? filterObject.asArray().map((entry) => resolve(context, entry))
        : [filterObject];
  const names = filters.map((filter) => (filter instanceof PDFName ? filter.asString() : "?"));
  const params = resolve(context, dict.get(PDFName.of("DecodeParms")));
  const firstParams = params instanceof PDFArray ? resolve(context, params.get(0)) : params;
  const predictor =
    firstParams instanceof PDFDict
      ? resolve(context, firstParams.get(PDFName.of("Predictor")))
      : undefined;
  if (predictor instanceof PDFNumber && predictor.asNumber() > 1) {
    throw pdfRefusal("The e-invoice attachment uses a stream encoding this server does not read");
  }

  if (names.length === 0) {
    if (stream.contents.byteLength > MAX_EINVOICE_XML_BYTES) throw attachmentTooLarge();
    return stream.contents;
  }
  if (names.length === 1 && (names[0] === "/FlateDecode" || names[0] === "/Fl")) {
    return inflateCapped(stream.contents);
  }
  throw pdfRefusal("The e-invoice attachment uses a stream encoding this server does not read");
}

/**
 * zlib-wrapped deflate as PDF's FlateDecode prescribes; raw deflate (some producers omit the
 * zlib header) as a fallback. Output is capped at the XML limit.
 */
function inflateCapped(contents: Uint8Array): Uint8Array {
  const options = { maxOutputLength: MAX_EINVOICE_XML_BYTES };
  for (const inflate of [inflateSync, inflateRawSync]) {
    try {
      return new Uint8Array(inflate(contents, options));
    } catch (error) {
      if (isTooLarge(error)) throw attachmentTooLarge();
    }
  }
  throw pdfRefusal("The e-invoice attachment in the PDF is damaged (cannot be decompressed)");
}

function isTooLarge(error: unknown): boolean {
  return (
    error instanceof RangeError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE")
  );
}

function attachmentTooLarge(): SevdeskError {
  return pdfRefusal(
    `The e-invoice attachment in the PDF is larger than ${String(MAX_EINVOICE_XML_BYTES)} bytes ` +
      "when decompressed, the limit of this server",
  );
}

function resolve(
  context: PDFDocument["context"],
  object: PDFObject | undefined,
): PDFObject | undefined {
  if (object === undefined) return undefined;
  if (object instanceof PDFRef) return context.lookup(object);
  return object;
}

function textOf(object: PDFObject | undefined): string | undefined {
  if (object instanceof PDFString || object instanceof PDFHexString) {
    const text = object.decodeText();
    return text === "" ? undefined : text;
  }
  return undefined;
}

function baseName(name: string): string {
  return name.split(/[/\\]/).pop() ?? name;
}

function pdfRefusal(reason: string): SevdeskError {
  return new SevdeskError({
    kind: "validation",
    message: `${reason}. Nothing was sent to sevDesk.`,
  });
}
