/**
 * `sevdesk_upload_request`: on a remote server with file transfer (`SEVDESK_HTTP_FILES`, HTTP
 * only), a page where the human uploads a receipt or e-invoice, and the `uploadId` the file tools
 * then take as `file`. The model never sees or sends file bytes, and it cannot put text on the
 * upload page (it shows only trusted values); the upload needs a browser session of the account.
 * See `src/safety/file-access.ts` and docs/adr/0008-file-transfer-over-http.md.
 *
 * Read tier: it changes nothing in sevDesk. Not idempotent: every call opens another ticket.
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
    .describe("Pass this as file to the tool that needs the file, once the user has uploaded it."),
  url: z
    .string()
    .describe(
      "Give this link to the user: they open it in the browser, signed in to this sevDesk " +
        "account, and upload the file there.",
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
    "the user, who opens it in the browser signed in to this sevDesk account and uploads the " +
    "file there. Wait until the user says the upload is done, then pass uploadId as file. Each " +
    "request takes one file and expires (expiresAt); the uploaded file stays usable for a while, " +
    "also for a retry. Nothing is sent to sevDesk.",
  toolset: "meta",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  available: remoteFilesEnabled,
  input: z.strictObject({
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
        "they open it in the browser, signed in to this sevDesk account, and upload one " +
        `${upload.accepts.map((kind) => kind.toUpperCase()).join(", ")} file of at most ` +
        `${megabytes(upload.maxBytes)} before ${upload.expiresAt}. When they say it is done, ` +
        "call the tool that needs the file with file set to uploadId. Nothing was sent to sevDesk.",
    };
  },
});

function kinds(purpose: UploadPurpose): string {
  return UPLOAD_KINDS[purpose].map((kind) => kind.toUpperCase()).join(", ");
}
