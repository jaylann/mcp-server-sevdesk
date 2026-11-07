import type { DocumentFileKind } from "../../domain/document-files.js";
import type { ToolsetName } from "../toolsets.js";

/**
 * The toolset each document file belongs to: its document type's toolset. The file tools and the
 * `sevdesk://` resource templates are exposed only when that toolset is enabled, and
 * `sevdesk_document_save` refuses kinds whose toolset is disabled.
 */
export const DOCUMENT_FILE_TOOLSETS: Readonly<Record<DocumentFileKind, ToolsetName>> = {
  invoice_pdf: "invoices",
  credit_note_pdf: "credit-notes",
  order_pdf: "orders",
  invoice_xml: "invoices",
};

/** Capitalized trusted noun per kind for summaries and link titles. */
export const DOCUMENT_FILE_LABELS: Readonly<Record<DocumentFileKind, string>> = {
  invoice_pdf: "Invoice",
  credit_note_pdf: "Credit note",
  order_pdf: "Order",
  invoice_xml: "Invoice",
};
