/**
 * `sevdesk_document_save`: hands a document file out through `ToolContext.files`: a new file in
 * `SEVDESK_OUTPUT_DIR`, or over HTTP with file transfer a download link. Split from the read tools
 * so those stay truly read-only and idempotent; this one declares what it does
 * (`readOnlyHint: false`, `idempotentHint: false`: every call creates another file or link), so
 * clients that auto-approve read-only tools still ask before it runs.
 *
 * Registration rule: toolset `meta` (always enabled; the tool spans three document toolsets, so
 * none of them fits) plus an `available` condition: files can be delivered (`SEVDESK_OUTPUT_DIR`
 * is set, the user's explicit opt-in to local files, or remote file transfer is on) and at least
 * one document toolset is enabled. Each call is also checked against the toolset of the requested
 * document kind, so disabling `orders` keeps order PDFs out of reach here too. It stays in the
 * `read` tier because it never changes anything in sevDesk (declared with
 * `localEffects: "writes-files"`).
 */
import { z } from "zod";

import {
  DOCUMENT_FILE_KINDS,
  DOCUMENT_FILE_SPECS,
  fetchDocumentFile,
} from "../../domain/document-files.js";
import { canDeliverFiles } from "../../safety/file-access.js";
import { defineTool } from "../define-tool.js";
import { deliveryData, deliveryOutputShape, downloadText } from "./delivery.js";
import { documentIdSchema, fileLink, fileMetadata, fileMetadataShape } from "./file-tools.js";
import { DOCUMENT_FILE_LABELS, DOCUMENT_FILE_TOOLSETS } from "./kinds.js";
import { refused } from "./save-file.js";

const output = z.object({
  ...fileMetadataShape,
  ...deliveryOutputShape,
});

/** `sevdesk_document_save`: a document file as a new file or a download link. */
export const documentSaveTool = defineTool({
  name: "sevdesk_document_save",
  title: "Save a document file",
  description:
    "Save the PDF of an invoice (Rechnung), credit note (Gutschrift) or order (Angebot, " +
    "Auftragsbestätigung, Lieferschein), or the XML of an e-invoice (E-Rechnung, XRechnung), " +
    "as a new file in SEVDESK_OUTPUT_DIR (on a remote server: a download link), e.g. to archive " +
    "or attach it. It writes only inside that folder, never overwrites a file (a taken name " +
    "gets a suffix such as RE-1001-1.pdf) and never changes anything in sevDesk: PDFs are " +
    "fetched as previews (preventSendBy), so nothing is marked as sent. Every call creates " +
    "another file or link, so save each document once. " +
    "To only look at a file, use sevdesk_invoice_pdf, sevdesk_credit_note_pdf, " +
    "sevdesk_order_pdf or sevdesk_invoice_xml instead.",
  toolset: "meta",
  tier: "read",
  localEffects: "writes-files",
  available: (config) =>
    canDeliverFiles(config) &&
    DOCUMENT_FILE_KINDS.some((kind) => config.toolsets.has(DOCUMENT_FILE_TOOLSETS[kind])),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.strictObject({
    document: z
      .enum(DOCUMENT_FILE_KINDS)
      .describe(
        "Which file: invoice_pdf, credit_note_pdf, order_pdf, or invoice_xml (e-invoice XML).",
      ),
    id: documentIdSchema,
  }),
  output,
  handler: async (args, ctx) => {
    const kind = args.document;
    const toolset = DOCUMENT_FILE_TOOLSETS[kind];
    // Both checks come first, so a refusal costs no sevDesk request.
    if (!ctx.config.toolsets.has(toolset)) {
      throw refused(
        `Saving ${DOCUMENT_FILE_SPECS[kind].noun} files needs the ${toolset} toolset, which is ` +
          "not enabled (SEVDESK_TOOLSETS)",
      );
    }
    await ctx.files.checkDelivery();
    const file = await fetchDocumentFile(ctx.client, kind, args.id, ctx.signal);
    const format = DOCUMENT_FILE_SPECS[kind].format;
    const delivery = await ctx.files.deliver({
      filename: file.filename,
      kind: format,
      bytes: file.bytes,
    });
    const data = fileMetadata(file);
    const what = `the ${format.toUpperCase()} file (${data.bytes} bytes)`;
    const done =
      "download" in delivery
        ? `${what} is ready as ${downloadText(delivery.download)}`
        : `saved ${what} as a new file in SEVDESK_OUTPUT_DIR`;
    return {
      data: { ...data, ...deliveryData(delivery) },
      summary: `${DOCUMENT_FILE_LABELS[kind]} ${args.id}: ${done}; nothing changed in sevDesk.`,
      extraContent: [fileLink(file)],
    };
  },
});
