/**
 * E-invoice parsing entry point: detects the container (standalone XML or a PDF with an attached
 * XML), the syntax (UBL or CII) and the profile, and returns a {@link ParsedEInvoice}.
 *
 * Contract:
 * - input are the raw file bytes (as read by `readConfinedFile`);
 * - never resolves external entities, refuses any DOCTYPE, caps sizes and nesting (`xml.ts`,
 *   `pdf-attachment.ts`);
 * - a file that is not an e-invoice at all (a plain PDF receipt, an image, an unrelated XML,
 *   ZUGFeRD 1.0) throws a `validation` `SevdeskError` with a trusted message saying what it is
 *   and what to do instead (e.g. "create the voucher with sevdesk_voucher_create_draft and attach
 *   the file");
 * - an e-invoice that violates business rules still parses: the violations are `findings`
 *   (`checks.ts`), errors first;
 * - deterministic: the same bytes give the same result.
 *
 * Detection: the container by the file's first bytes (`sniffKind`, as the file reader does); the
 * syntax by the root element's local name and namespace URI: `CrossIndustryInvoice` in
 * `urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100` (CII), `Invoice` / `CreditNote`
 * in the UBL 2 namespaces, `CrossIndustryDocument` (ZUGFeRD 1.0, refused).
 */
import { sniffKind } from "../../safety/local-files.js";
import { cleanText } from "../common.js";
import { checkEInvoice, sortFindings } from "./checks.js";
import { CII_NAMESPACE, readCii } from "./cii.js";
import type { ExtractedEInvoice } from "./extracted.js";
import { unreadable } from "./fields.js";
import { type ParsedEInvoice, parsedEInvoiceSchema } from "./model.js";
import { extractEInvoiceXml, PLAIN_RECEIPT_HINT } from "./pdf-attachment.js";
import { readUbl, UBL_NAMESPACES } from "./ubl.js";
import { hasWideByteOrderMark, parseXmlDocument, type XmlDocument, xmlRefusal } from "./xml.js";

export interface ParseEInvoiceOptions {
  /**
   * The file's name. Reserved for callers; it is untrusted, so it is never put into messages,
   * and the attachment inside a PDF is chosen by its own name.
   */
  readonly fileName?: string;
}

/** Longest attachment name kept in the result. */
const ATTACHMENT_NAME_MAX = 100;

/** Parses an XRechnung or ZUGFeRD/Factur-X file; see the module doc. */
export async function parseEInvoice(
  bytes: Uint8Array,
  _options: ParseEInvoiceOptions = {},
): Promise<ParsedEInvoice> {
  // A UTF-16/32 byte order mark: let the XML reader refuse it with the UTF-8-only message.
  const kind = hasWideByteOrderMark(bytes) ? "xml" : sniffKind(bytes);
  let xml: Uint8Array;
  let attachmentName: string | undefined;
  if (kind === "pdf") {
    const attachment = await extractEInvoiceXml(bytes);
    xml = attachment.bytes;
    attachmentName = cleanText(attachment.name, ATTACHMENT_NAME_MAX);
  } else if (kind === "xml") {
    xml = bytes;
  } else {
    const what =
      kind === undefined ? "neither an XML nor a PDF file" : "an image, not an XML or PDF file";
    throw xmlRefusal(`The file is ${what}, so it is not an e-invoice. ${PLAIN_RECEIPT_HINT}`);
  }

  const document = parseXmlDocument(
    xml,
    kind === "pdf" ? "The PDF's e-invoice attachment" : "The file",
  );
  const extracted = readDocument(document);
  const findings = sortFindings([
    ...extracted.findings,
    ...checkEInvoice(extracted.content, extracted.facts),
  ]);
  const parsed = parsedEInvoiceSchema.safeParse({
    ...extracted.content,
    container: kind,
    ...(attachmentName === undefined ? {} : { attachmentName }),
    findings,
  });
  if (!parsed.success) {
    throw unreadable("The e-invoice contains values outside the supported format");
  }
  return parsed.data;
}

/** Picks the reader by root element and namespace; refuses everything else. */
function readDocument(document: XmlDocument): ExtractedEInvoice {
  const { root, namespace } = document;
  if (root.name === "CrossIndustryInvoice" && namespace === CII_NAMESPACE) {
    return readCii(root);
  }
  if (root.name === "Invoice" && namespace === UBL_NAMESPACES.Invoice) {
    return readUbl(root, "Invoice");
  }
  if (root.name === "CreditNote" && namespace === UBL_NAMESPACES.CreditNote) {
    return readUbl(root, "CreditNote");
  }
  if (root.name === "CrossIndustryDocument") {
    throw xmlRefusal(
      "The file is a ZUGFeRD 1.0 invoice (CrossIndustryDocument). ZUGFeRD 1.0 is outdated and " +
        "not supported: ask the sender for ZUGFeRD 2.x, Factur-X or XRechnung, or book it from " +
        "the PDF with sevdesk_voucher_create_draft and the file",
    );
  }
  if (
    root.name === "CrossIndustryInvoice" ||
    root.name === "Invoice" ||
    root.name === "CreditNote"
  ) {
    throw xmlRefusal(
      "The XML's root element has an e-invoice name but not the namespace of UBL 2.1 or " +
        "UN/CEFACT CII D16B, so it is not an EN 16931 e-invoice",
    );
  }
  throw xmlRefusal(
    "The XML is not an e-invoice: its root element is neither a UBL Invoice/CreditNote nor a " +
      `UN/CEFACT CrossIndustryInvoice. ${PLAIN_RECEIPT_HINT}`,
  );
}
