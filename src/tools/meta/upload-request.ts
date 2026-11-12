/**
 * `sevdesk_upload_request`: on a remote server with file transfer (`SEVDESK_HTTP_FILES`, HTTP
 * only), a page where the human uploads a receipt or e-invoice, and the `uploadId` the file tools
 * then take as `file`. The model never sees or sends file bytes, and it cannot put text on the
 * upload page (it shows only trusted values); the upload needs a browser session of the account.
 * See `src/safety/file-access.ts` and docs/adr/0008-file-transfer-over-http.md.
 *
 * Read tier: it changes nothing in sevDesk. It is not read-only all the same (`readOnlyHint:
 * false`, `localEffects: "opens-upload"`): every call opens another ticket in the transfer store,
 * of which an account holds only a few at a time, so a client that runs read-only tools without
 * asking could use them up (review 2026-11, round 3). For the same reason it is not idempotent.
 */
import { z } from "zod";

import { remoteFilesEnabled } from "../../safety/file-access.js";
import { megabytes } from "../../safety/transfer-store.js";
import { UPLOAD_KINDS, type UploadPurpose } from "../../safety/transfer-types.js";
import { defineTool } from "../define-tool.js";

const PURPOSES = ["receipt", "einvoice"] as const satisfies readonly UploadPurpose[];

const output = z.object({
  uploadId: z
    .string()
    .optional()
    .describe(
      "For count 1: pass this as file to the tool that needs the file, once the user has uploaded it.",
    ),
  batchId: z
    .string()
    .optional()
    .describe("For count > 1: resolve with sevdesk_uploads_list after the upload."),
  count: z.number().int().optional().describe("Number of reserved file slots for a batch."),
  url: z
    .string()
    .describe(
      "Give this link to the user: they open it in the browser they connected this server " +
        "with (any other browser asks for the account's sevDesk API token) and upload the " +
        "file there.",
    ),
  reference: z.string().describe("Short code the upload page shows, to match the request."),
  expiresAt: z.string().describe("ISO 8601: the file must be uploaded before then."),
  accepts: z
    .array(z.enum(["pdf", "png", "jpeg", "xml"]))
    .describe("File types the page accepts, checked by content."),
  maxBytes: z.number().int().describe("Largest accepted file in bytes."),
});

/** `sevdesk_upload_request`: an upload page for a receipt or e-invoice (remote file transfer). */
export const uploadRequestTool = defineTool({
  name: "sevdesk_upload_request",
  title: "Request a file upload",
  description:
    "Let the user upload a file to this remote server, for the tools that take a file " +
    "(sevdesk_voucher_create_draft, sevdesk_voucher_update_draft, sevdesk_einvoice_parse, " +
    "sevdesk_voucher_import_einvoice): purpose receipt (Beleg, Belegbild: PDF, PNG or JPEG) or " +
    "einvoice (E-Rechnung: XRechnung XML or ZUGFeRD/Factur-X PDF). Returns a link: give it to " +
    "the user, who opens it in the browser they connected this server with and uploads the " +
    "file there. Wait until the user says the upload is done, then pass uploadId as file. Each " +
    "request expires (expiresAt). Optional count (1–10, default 1) reserves several files on one " +
    "page: for count > 1, call sevdesk_uploads_list with batchId after the upload to match cleaned " +
    "names to uploadIds. Uploaded files stay usable until expiry or successful attachment. " +
    "Nothing is sent to sevDesk.",
  toolset: "meta",
  tier: "read",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  localEffects: "opens-upload",
  available: remoteFilesEnabled,
  input: z.strictObject({
    count: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Files to upload on one page (default 1). Every file uses one account slot."),
    purpose: z
      .enum(PURPOSES)
      .describe(
        `receipt (${kinds("receipt")}) for a voucher draft, einvoice (${kinds("einvoice")}) ` +
          "for sevdesk_einvoice_parse and sevdesk_voucher_import_einvoice.",
      ),
  }),
  output,
  // eslint-disable-next-line @typescript-eslint/require-await -- the contract is async; this is not.
  handler: async (args, ctx) => {
    if ((args.count ?? 1) > 1) {
      const batch = ctx.files.requestUploadBatch(args.purpose, args.count ?? 1);
      return {
        data: { ...batch, accepts: [...batch.accepts] },
        summary:
          `Upload request ${batch.reference} (${args.purpose}): give the user the link in url ` +
          `to upload up to ${String(batch.count)} files before ${batch.expiresAt}, each at most ` +
          `${megabytes(batch.maxBytes)}. When they say it is done, call sevdesk_uploads_list with ` +
          "batchId to match cleaned file names to uploadIds, then pass each uploaded file's " +
          "uploadId as file. Nothing was sent to sevDesk.",
      };
    }
    const upload = ctx.files.requestUpload(args.purpose);
    return {
      data: {
        uploadId: upload.uploadId,
        url: upload.url,
        reference: upload.reference,
        expiresAt: upload.expiresAt,
        accepts: [...upload.accepts],
        maxBytes: upload.maxBytes,
      },
      summary:
        `Upload request ${upload.reference} (${args.purpose}): give the user the link in url; ` +
        "they open it in the browser they connected this server with (any other browser asks " +
        "for the account's sevDesk API token) and upload one " +
        `${upload.accepts.map((kind) => kind.toUpperCase()).join(", ")} file of at most ` +
        `${megabytes(upload.maxBytes)} before ${upload.expiresAt}. When they say it is done, ` +
        "call the tool that needs the file with file set to uploadId. Nothing was sent to sevDesk.",
    };
  },
});

function kinds(purpose: UploadPurpose): string {
  return UPLOAD_KINDS[purpose].map((kind) => kind.toUpperCase()).join(", ");
}
