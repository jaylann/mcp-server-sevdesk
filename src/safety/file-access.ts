/**
 * Where tools get file bytes from and where they hand files out, independent of how the server
 * is reached. Tools never touch the file system or the transfer store directly; they go through
 * the {@link FileAccess} in their context (implementations: `./file-sources.ts`):
 *
 * - **stdio** (and bearer mode with local folders): reads come from `SEVDESK_FILE_DIRS` through
 *   `readConfinedFile` (`./local-files.ts`), deliveries are new files in `SEVDESK_OUTPUT_DIR`
 *   (`./output-files.ts`).
 * - **HTTP with remote file transfer** (`deployment.files`): a file reference may be an
 *   `upload:<id>` from `sevdesk_upload_request` (the human uploads the file on a page of this
 *   server, signed in to the account), and deliveries become short-lived download links that also
 *   need that browser session. See docs/adr/0008-file-transfer-over-http.md.
 *
 * Invariant: every byte a tool reads or hands out passes one of these two paths, so the
 * confinement rules (local folders, account-bound uploads and links) hold for every tool.
 */
import type { Config } from "../config.js";
import type { LocalFileKind } from "./local-files.js";
import type { UploadPurpose } from "./transfer-types.js";

/** A file a tool read, from a local folder or from an upload. */
export interface InputFile {
  /** Base name as given by the file system or the uploader. Untrusted: sanitize before display. */
  readonly name: string;
  readonly kind: LocalFileKind;
  readonly bytes: Uint8Array;
  readonly source: "local" | "upload";
}

/** What a caller accepts when reading a file. */
export interface ReadFileOptions {
  /** Largest accepted file in bytes. */
  readonly maxBytes: number;
  /** Kinds the caller can handle; anything else is refused. */
  readonly kinds: readonly LocalFileKind[];
}

/**
 * Kinds of files tools hand out: document PDFs, e-invoice XML, CSV and DATEV exports, and voucher
 * receipts (PDF, PNG, JPEG or XML).
 */
export type OutputFileKind = "pdf" | "xml" | "csv" | "zip" | "png" | "jpeg";

/** A file a tool hands out. */
export interface OutputFile {
  /** Plain base name built from our own values (never a path). */
  readonly filename: string;
  readonly kind: OutputFileKind;
  readonly bytes: Uint8Array;
}

/** A new upload ticket, as `sevdesk_upload_request` reports it. */
export interface UploadRequest {
  /** What tools accept as `file`: `upload:<id>` ({@link uploadRef}). */
  readonly uploadId: string;
  /** The page where the human uploads the file (needs a browser session of the account). */
  readonly url: string;
  /** Short code shown on the page and in the tool result, so the human can match them. */
  readonly reference: string;
  /** ISO 8601: the upload must happen before then. */
  readonly expiresAt: string;
  /** Kinds the page accepts, recognized by content. */
  readonly accepts: readonly LocalFileKind[];
  /** Largest accepted file in bytes. */
  readonly maxBytes: number;
}

/** Where a delivered file went. */
export type Delivery =
  | {
      /** Absolute path of the new file inside `SEVDESK_OUTPUT_DIR`. */
      readonly savedTo: string;
    }
  | {
      /** A download link that needs a browser session of the account. */
      readonly download: {
        readonly url: string;
        /** Short code shown on the page and in the tool result, so the human can match them. */
        readonly reference: string;
        /** ISO 8601 timestamp. */
        readonly expiresAt: string;
      };
    };

/**
 * The file capabilities of one tool call. Built per call by the registry from the config and,
 * in HTTP mode, the request's principal.
 */
export interface FileAccess {
  /** Whether {@link FileAccess.read} can succeed at all in this configuration. */
  readonly canRead: boolean;
  /** Whether {@link FileAccess.deliver} can succeed at all in this configuration. */
  readonly canDeliver: boolean;
  /**
   * Opens a single-use upload ticket of the calling principal (HTTP with file transfer only).
   * Throws a local `validation` `SevdeskError` with a trusted message where uploads are not
   * available or a limit of the transfer store is reached.
   */
  requestUpload(purpose: UploadPurpose): UploadRequest;
  /**
   * Reads the file `ref` names: a path (inside `SEVDESK_FILE_DIRS`) or an `upload:<id>`
   * reference. Throws a local `validation` `SevdeskError` with a trusted message when the
   * reference is not allowed, unknown, expired, too large or of the wrong kind.
   */
  read(ref: string, options: ReadFileOptions): Promise<InputFile>;
  /** Hands `file` out: a new file in `SEVDESK_OUTPUT_DIR`, or a download link over HTTP. */
  deliver(file: OutputFile): Promise<Delivery>;
  /**
   * Checks, before a tool asks sevDesk for anything, that {@link FileAccess.deliver} can work
   * now: the output folder exists and is writable. Throws a local `validation` `SevdeskError`
   * with a trusted message otherwise. Download links need no check here (their limits are
   * checked when the file is stored).
   */
  checkDelivery(): Promise<void>;
  /**
   * Trusted, deterministic text for previews, e.g. "a new file in /srv/exports" or "a download
   * link (opened in the browser they connected this server with; valid 30 minutes)". No clock
   * times, no ids.
   */
  describeDelivery(): string;
}

/** Prefix of a file reference that names an upload instead of a path. */
export const UPLOAD_REF_PREFIX = "upload:";

/**
 * @public The format of an upload reference: the prefix and a 43-character base64url id
 * (`randomId()`, 32 bytes). Code goes through {@link parseUploadRef}.
 */
export const UPLOAD_REF = /^upload:([A-Za-z0-9_-]{43})$/;

/** The upload id in `ref`, or `undefined` when `ref` is not an upload reference. */
export function parseUploadRef(ref: string): string | undefined {
  return UPLOAD_REF.exec(ref)?.[1];
}

/** The reference tools accept for upload `id`. */
export function uploadRef(id: string): string {
  return `${UPLOAD_REF_PREFIX}${id}`;
}

/** Whether remote file transfer is on for this deployment. */
export function remoteFilesEnabled(config: Pick<Config, "deployment">): boolean {
  return config.deployment.kind === "http" && config.deployment.files !== undefined;
}

/** Whether tools that read files are offered: local folders or remote uploads. */
export function canReadFiles(config: Pick<Config, "fileDirs" | "deployment">): boolean {
  return config.fileDirs.length > 0 || remoteFilesEnabled(config);
}

/** Whether tools that hand out files are offered: an output folder or remote download links. */
export function canDeliverFiles(config: Pick<Config, "outputDir" | "deployment">): boolean {
  return config.outputDir !== undefined || remoteFilesEnabled(config);
}
