/**
 * Contracts of remote file transfer (HTTP mode, `deployment.files`): upload tickets the human
 * fills on a page of this server, and download links for files tools hand out. The tool side
 * ({@link TransferStore}) is what `remoteFileAccess` and `sevdesk_upload_request` use; the
 * browser side (pages, sessions) lives in `src/http/transfer-routes.ts` and builds on the same
 * store implementation (`src/safety/transfer-store.ts`).
 *
 * Ownership: every ticket, upload and link belongs to the {@link RequestPrincipal} that created
 * it. Tools read only uploads of their own grant (`grantKey` and `accountScope`); browser pages
 * show and accept only records of the session's account. A restart voids everything (records
 * live in memory; blobs on disk are encrypted with a per-process key and removed at startup).
 * See docs/adr/0008-file-transfer-over-http.md.
 */
import type { RequestPrincipal } from "../accounts/types.js";
import type { InputFile, OutputFile, OutputFileKind } from "./file-access.js";
import type { LocalFileKind } from "./local-files.js";

/** What an upload is for; decides the accepted kinds. */
export type UploadPurpose = "receipt" | "einvoice";

/** Accepted kinds per purpose: receipts as PDF or image, e-invoices as XML or PDF (ZUGFeRD). */
export const UPLOAD_KINDS: Readonly<Record<UploadPurpose, readonly LocalFileKind[]>> = {
  receipt: ["pdf", "png", "jpeg"],
  einvoice: ["xml", "pdf"],
};

/** A new upload ticket, as the tool reports it. */
export interface UploadTicketView {
  /** 43-character base64url id; the tool reference is `upload:<id>`. */
  readonly id: string;
  /** Short code shown on the page and in the tool result. */
  readonly reference: string;
  readonly purpose: UploadPurpose;
  readonly kinds: readonly LocalFileKind[];
  readonly maxBytes: number;
  /** ISO 8601: the ticket must be used before then. */
  readonly expiresAt: string;
}

/** A new download link, as the tool reports it. */
export interface DownloadLinkView {
  readonly id: string;
  readonly reference: string;
  readonly filename: string;
  readonly kind: OutputFileKind;
  /** As the file tools name it, e.g. `application/pdf`. */
  readonly mimeType: string;
  /** Size in bytes. */
  readonly bytes: number;
  /** ISO 8601. */
  readonly expiresAt: string;
}

/** Thrown when a per-account or global limit of tickets, links or stored bytes is reached. */
export class TransferLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferLimitError";
  }
}

/** The tool side of the transfer store. */
export interface TransferStore {
  /** Opens a single-use upload ticket for `owner`. Throws {@link TransferLimitError}. */
  createTicket(owner: RequestPrincipal, purpose: UploadPurpose): UploadTicketView;
  /**
   * The uploaded file of ticket `id` when it belongs to `owner` (same grant and account) and was
   * uploaded and has not expired; `undefined` otherwise (unknown, foreign, pending and expired
   * look the same). Reading does not consume the upload, so a failed write can be retried until
   * it expires.
   */
  readUpload(owner: RequestPrincipal, id: string): Promise<InputFile | undefined>;
  /**
   * Releases a successfully attached upload of `owner` (same grant and account): removes its
   * record immediately and schedules blob deletion, as for expiry. Idempotent; unknown,
   * foreign, pending and receiving tickets and download links are untouched. Call only after
   * sevDesk confirms the attachment, never after a read, preview or failed write.
   */
  releaseUpload(owner: RequestPrincipal, id: string): void;
  /** Stores `file` and returns a link for `owner`'s account. Throws {@link TransferLimitError}. */
  createDownload(owner: RequestPrincipal, file: OutputFile): Promise<DownloadLinkView>;
}

/** The page where the human uploads the file for ticket `id`. */
export function uploadPageUrl(publicOrigin: string, id: string): string {
  return `${publicOrigin}/uploads/${id}`;
}

/** The URL that serves the file of download link `id`. */
export function downloadUrl(publicOrigin: string, id: string): string {
  return `${publicOrigin}/files/${id}`;
}
