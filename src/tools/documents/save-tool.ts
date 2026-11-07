/**
 * `sevdesk_document_save`: the one tool that writes local files. Split from the read tools so
 * those stay truly read-only and idempotent; this one declares what it does
 * (`readOnlyHint: false`, `idempotentHint: false`: every call creates another file), so clients
 * that auto-approve read-only tools still ask before it runs.
 *
 * Registration rule: toolset `meta` (always enabled; the tool spans three document toolsets, so
 * none of them fits) plus an `available` condition: `SEVDESK_OUTPUT_DIR` is set (the user's
 * explicit opt-in to local files) and at least one document toolset is enabled. Each call is
 * also checked against the toolset of the requested document kind, so disabling `orders` keeps
 * order PDFs out of reach here too. It stays in the `read` tier because it never changes
 * anything in sevDesk (declared with `localEffects: "writes-files"`).
 */
import { z } from "zod";

import {
  DOCUMENT_FILE_KINDS,
  DOCUMENT_FILE_SPECS,
  fetchDocumentFile,
} from "../../domain/document-files.js";
import { defineTool } from "../define-tool.js";
import { documentIdSchema, fileLink, fileMetadata, fileMetadataShape } from "./file-tools.js";
import { DOCUMENT_FILE_LABELS, DOCUMENT_FILE_TOOLSETS } from "./kinds.js";
import { refused, resolveOutputDir, writeNewFile } from "./save-file.js";

const output = z.object({
  ...fileMetadataShape,
  savedTo: z.string().describe("Absolute path of the new file inside SEVDESK_OUTPUT_DIR."),
});

/** `sevdesk_document_save`: saves a document file as a new file in `SEVDESK_OUTPUT_DIR`. */
export const documentSaveTool = defineTool({
  name: "sevdesk_document_save",
  title: "Save a document file to disk",
  description:
    "Save the PDF of an invoice (Rechnung), credit note (Gutschrift) or order (Angebot, " +
    "Auftragsbestätigung, Lieferschein), or the XML of an e-invoice (E-Rechnung, XRechnung), " +
    "as a new file in SEVDESK_OUTPUT_DIR, e.g. to archive or attach it. It writes only inside " +
    "that folder, never overwrites a file (a taken name gets a suffix such as RE-1001-1.pdf) " +
    "and never changes anything in sevDesk: PDFs are fetched as previews (preventSendBy), so " +
    "nothing is marked as sent. Every call creates another file, so save each document once. " +
    "To only look at a file, use sevdesk_invoice_pdf, sevdesk_credit_note_pdf, " +
    "sevdesk_order_pdf or sevdesk_invoice_xml instead.",
  toolset: "meta",
  tier: "read",
  localEffects: "writes-files",
  available: (config) =>
    config.outputDir !== undefined &&
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
    const directory = await resolveOutputDir(ctx.config.outputDir);
    const file = await fetchDocumentFile(ctx.client, kind, args.id, ctx.signal);
    const savedTo = await writeNewFile(directory, file.filename, file.bytes);
    const data = fileMetadata(file);
    const format = DOCUMENT_FILE_SPECS[kind].format.toUpperCase();
    return {
      data: { ...data, savedTo },
      summary:
        `${DOCUMENT_FILE_LABELS[kind]} ${args.id}: saved the ${format} file (${data.bytes} ` +
        "bytes) as a new file in SEVDESK_OUTPUT_DIR; nothing changed in sevDesk.",
      extraContent: [fileLink(file)],
    };
  },
});
