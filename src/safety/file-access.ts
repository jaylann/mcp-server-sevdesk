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
 * - **Either mode, with `SEVDESK_FILE_URL_HOSTS`**: a file reference may also be an https link to
 *   one of the operator's hosts; `./url-files.ts` downloads it during the call (public addresses
 *   only, pinned connection, capped) and keeps nothing.
 *
 * Invariant: every byte a tool reads or hands out passes one of these paths, so the confinement
 * rules (local folders, account-bound uploads and links, the allowed public hosts) hold for every
 * tool.
 */
import type { Config } from "../config.js";
import type { LocalFileKind } from "./local-files.js";
import type { UploadBatchState, UploadPurpose } from "./transfer-types.js";

/** A file a tool read: from a local folder, from an upload, or downloaded from an https link. */
export interface InputFile {
  /**
   * Base name as given by the file system or the uploader, or taken from the link's path.
   * Untrusted: sanitize before display.
   */
  readonly name: string;
  readonly kind: LocalFileKind;
  readonly bytes: Uint8Array;
  readonly source: "local" | "upload" | "url";
  /**
   * `source: "url"` only: the host the file was downloaded from, one of `SEVDESK_FILE_URL_HOSTS`
   * (where a redirect led, the last one). Never the path or query of the link.
   */
  readonly host?: string | undefined;
}

/** What a caller accepts when reading a file. */
export interface ReadFileOptions {
  /** Largest accepted file in bytes. */
  readonly maxBytes: number;
  /** Kinds the caller can handle; anything else is refused. */
  readonly kinds: readonly LocalFileKind[];
  /** The tool call's cancellation: stops a download from a link. */
  readonly signal?: AbortSignal | undefined;
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

/** One page for several files; resolve names and upload references after the human uploads. */
interface UploadBatchRequest extends Omit<UploadRequest, "uploadId"> {
  readonly batchId: string;
  readonly count: number;
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
  /** Opens one batch page, atomically reserving `count` file slots. */
  requestUploadBatch(purpose: UploadPurpose, count: number): UploadBatchRequest;
  /** Reads this connection's batch metadata without reading bytes or creating records. */
  listUploads(batchId: string): UploadBatchState;
  /**
   * Reads the file `ref` names: a path (inside `SEVDESK_FILE_DIRS`), an `upload:<id>` reference,
   * or an https link ({@link isUrlRef}) to a host in `SEVDESK_FILE_URL_HOSTS`. Throws a local
   * `validation` `SevdeskError` with a trusted message when the reference is not allowed,
   * unknown, expired, unreachable, too large or of the wrong kind (`aborted` when
   * `options.signal` stops a download).
   */
  read(ref: string, options: ReadFileOptions): Promise<InputFile>;
  /**
   * Releases a remote upload after sevDesk confirms it was attached successfully. Local files
   * are never deleted, and a file from a link was never kept (its bytes live only in the call).
   * Unknown, foreign or already released references are harmless no-ops; reads, previews and
   * failed writes must not call this.
   */
  release(ref: string): void;
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

/**
 * A scheme of two or more characters followed by `://`. A Windows drive (`C:/…`, one letter) does
 * not match, and a local file whose name looks like this is passed as `./https:…`.
 */
const URL_REF = /^[a-z][a-z0-9+.-]+:\/\//i;

/**
 * Whether `ref` names a link rather than a path or an upload: anything that starts like a URL.
 * Only https links to the allowed hosts are read; every other scheme is refused with a message,
 * never taken for a path.
 */
export function isUrlRef(ref: string): boolean {
  return URL_REF.test(ref);
}

/**
 * `ref` as a log may hold it: a link without its user info, query and fragment (a signed link
 * carries its signature there), anything else unchanged.
 */
export function loggableFileRef(ref: string): string {
  if (!isUrlRef(ref)) return ref;
  // The user info ends at the last `@` before the path, as URL parsers read it.
  const match = /^([^:]+:\/\/)(?:[^/?#]*@)?([^?#]*)([?#][\s\S]*)?$/.exec(ref);
  const [, scheme = "", rest = "", tail] = match ?? [];
  return `${scheme}${rest}${tail === undefined ? "" : "?[redacted]"}`;
}

/** Whether remote file transfer is on for this deployment. */
export function remoteFilesEnabled(config: Pick<Config, "deployment">): boolean {
  return config.deployment.kind === "http" && config.deployment.files !== undefined;
}

/**
 * Whether tools that read files are offered: local folders, remote uploads, or hosts files may be
 * downloaded from.
 */
export function canReadFiles(
  config: Pick<Config, "fileDirs" | "deployment" | "fileUrlHosts">,
): boolean {
  return config.fileDirs.length > 0 || remoteFilesEnabled(config) || config.fileUrlHosts.length > 0;
}

/** Whether tools that hand out files are offered: an output folder or remote download links. */
export function canDeliverFiles(config: Pick<Config, "outputDir" | "deployment">): boolean {
  return config.outputDir !== undefined || remoteFilesEnabled(config);
}
