/**
 * The two implementations of {@link FileAccess}; the registry picks one per tool call
 * (`src/tools/registry.ts`):
 *
 * - {@link localFileAccess} (stdio, and HTTP with file transfer off): reads only inside
 *   `SEVDESK_FILE_DIRS` (`readConfinedFile`), delivers only as new files in `SEVDESK_OUTPUT_DIR`
 *   (`resolveOutputDir` + `writeNewFile`). An `upload:` reference is refused with a hint; a local
 *   file literally named like that is passed as `./upload:…`.
 * - {@link remoteFileAccess} (HTTP with `deployment.files`): an `upload:<id>` reference reads the
 *   upload of the calling principal from the transfer store; a plain path still goes to the local
 *   folders when `SEVDESK_FILE_DIRS` is set (bearer mode). Deliveries become download links of the
 *   principal's account, unless `SEVDESK_OUTPUT_DIR` is set, which wins.
 *
 * Every refusal is a local `validation` {@link SevdeskError} with trusted text (no ids, no file
 * content; upload names come cleaned from the store and are shown only sanitized). Upload ids are
 * never put into messages: they only travel in the tool arguments the model already has.
 */
import type { RequestPrincipal } from "../accounts/types.js";
import type { Config } from "../config.js";
import { SevdeskError } from "../sevdesk/errors.js";
import { sanitizeUntrusted } from "./fence.js";
import {
  type FileAccess,
  type InputFile,
  type OutputFile,
  parseUploadRef,
  type ReadFileOptions,
  UPLOAD_REF_PREFIX,
  uploadRef,
  type UploadRequest,
} from "./file-access.js";
import { type LocalFileKind, readConfinedFile } from "./local-files.js";
import { refused, resolveOutputDir, writeNewFile } from "./output-files.js";
import { duration } from "./transfer-store.js";
import {
  type DownloadLinkView,
  downloadUrl,
  TransferLimitError,
  type TransferStore,
  uploadPageUrl,
  type UploadTicketView,
} from "./transfer-types.js";

/** What {@link localFileAccess} reads of the configuration. */
export type LocalFileConfig = Pick<Config, "fileDirs" | "outputDir">;

/** What {@link remoteFileAccess} reads of the configuration. */
export type RemoteFileConfig = Pick<Config, "fileDirs" | "outputDir" | "deployment">;

const NOTHING_SENT = "Nothing was sent to sevDesk.";

/**
 * File access over the local folders only: `SEVDESK_FILE_DIRS` for reading, `SEVDESK_OUTPUT_DIR`
 * for delivering. With neither set, every read and delivery is refused with a message naming the
 * setting.
 */
export function localFileAccess(config: LocalFileConfig): FileAccess {
  const { fileDirs, outputDir } = config;
  return {
    canRead: fileDirs.length > 0,
    canDeliver: outputDir !== undefined,
    requestUpload() {
      throw refusal(
        "Uploads need a remote server with file transfer (SEVDESK_HTTP_FILES); this server reads " +
          "files from the folders in SEVDESK_FILE_DIRS. Ask the user to put the file there and " +
          "pass its path",
      );
    },
    async read(ref, options) {
      if (ref.startsWith(UPLOAD_REF_PREFIX)) {
        throw refusal(
          "upload: references come from sevdesk_upload_request, which only a remote server with " +
            "file uploads offers; this server reads files from the folders in SEVDESK_FILE_DIRS. " +
            "Pass a path inside them (a file whose name starts with upload: as ./upload:…)",
        );
      }
      return readLocal(fileDirs, ref, options);
    },
    deliver: async (file) => ({ savedTo: await saveLocal(outputDir, file) }),
    async checkDelivery() {
      await outputDirectory(outputDir);
    },
    describeDelivery: () =>
      outputDir === undefined
        ? "nowhere: SEVDESK_OUTPUT_DIR is not set"
        : `a new file in SEVDESK_OUTPUT_DIR (${outputDir})`,
  };
}

/**
 * File access of one HTTP request with remote file transfer on: uploads and download links of
 * `principal` in `store`, with the local folders where configured (see the module doc).
 * `config.deployment` must be the HTTP deployment with `files` set.
 */
export function remoteFileAccess(
  config: RemoteFileConfig,
  store: TransferStore,
  principal: RequestPrincipal,
): FileAccess {
  const { deployment } = config;
  if (deployment.kind !== "http" || deployment.files === undefined) {
    throw new Error("remoteFileAccess needs an HTTP deployment with file transfer on.");
  }
  const { publicOrigin } = deployment;
  const lifetime = duration(deployment.files.ttlSeconds * 1000);
  const local = localFileAccess(config);
  const localOutput = config.outputDir !== undefined;
  return {
    canRead: true,
    canDeliver: true,
    requestUpload(purpose): UploadRequest {
      let ticket: UploadTicketView;
      try {
        ticket = store.createTicket(principal, purpose);
      } catch (error) {
        throw limitRefusal(error);
      }
      return {
        uploadId: uploadRef(ticket.id),
        url: uploadPageUrl(publicOrigin, ticket.id),
        reference: ticket.reference,
        expiresAt: ticket.expiresAt,
        accepts: ticket.kinds,
        maxBytes: ticket.maxBytes,
      };
    },
    async read(ref, options) {
      if (!ref.startsWith(UPLOAD_REF_PREFIX)) {
        if (config.fileDirs.length > 0) return readLocal(config.fileDirs, ref, options);
        throw refusal(
          "This server reads no local paths: the file has to be uploaded. Call " +
            "sevdesk_upload_request, ask the user to upload the file on the page it returns and " +
            "to say when it is done, then pass its uploadId as file",
        );
      }
      const id = parseUploadRef(ref);
      if (id === undefined) {
        throw refusal(
          "The file reference starts with upload: but is not an uploadId as " +
            "sevdesk_upload_request returns it (upload: and 43 characters); pass it exactly as " +
            "returned",
        );
      }
      const file = await store.readUpload(principal, id);
      if (file === undefined) {
        throw refusal(
          "There is no uploaded file for this uploadId: the user has not finished the upload " +
            "yet, it expired, or it was requested by another connection. Ask the user to finish " +
            "the upload on the page from sevdesk_upload_request and to say when it is done, then " +
            "call again; if it expired, request a new upload",
        );
      }
      return checkUpload(file, options);
    },
    async deliver(file) {
      if (localOutput) return local.deliver(file);
      let link: DownloadLinkView;
      try {
        link = await store.createDownload(principal, file);
      } catch (error) {
        throw limitRefusal(error);
      }
      return {
        download: {
          url: downloadUrl(publicOrigin, link.id),
          reference: link.reference,
          expiresAt: link.expiresAt,
        },
      };
    },
    async checkDelivery() {
      if (localOutput) await local.checkDelivery();
    },
    describeDelivery: () =>
      localOutput
        ? local.describeDelivery()
        : "a download link for the user (opened in the browser they connected this server " +
          `with; valid ${lifetime})`,
  };
}

/** A {@link TransferLimitError} (trusted text from the store) as a local refusal; else `error`. */
function limitRefusal(error: unknown): unknown {
  return error instanceof TransferLimitError
    ? new SevdeskError({ kind: "validation", message: error.message, cause: error })
    : error;
}

async function readLocal(
  fileDirs: readonly string[],
  ref: string,
  options: ReadFileOptions,
): Promise<InputFile> {
  const file = await readConfinedFile(fileDirs, ref, options);
  return { name: file.name, kind: file.kind, bytes: file.bytes, source: "local" };
}

/** Applies the caller's kinds and size limit to an upload (the page checked its own). */
function checkUpload(file: InputFile, options: ReadFileOptions): InputFile {
  if (!options.kinds.includes(file.kind)) {
    throw refusal(
      `The uploaded file ${shownName(file.name)} is a ${kindLabel(file.kind)} file; accepted ` +
        `here: ${options.kinds.map(kindLabel).join(", ")} (checked by content). Ask the user to ` +
        "upload the right file through a new sevdesk_upload_request",
    );
  }
  if (file.bytes.byteLength > options.maxBytes) {
    throw refusal(
      `The uploaded file ${shownName(file.name)} has ${String(file.bytes.byteLength)} bytes; ` +
        `the limit here is ${String(options.maxBytes)} bytes`,
    );
  }
  return file;
}

/** The real output folder, or a refusal naming the setting. */
async function outputDirectory(outputDir: string | undefined): Promise<string> {
  if (outputDir === undefined) {
    throw refused(
      "Saving files is off: SEVDESK_OUTPUT_DIR is not set (in the Claude Desktop extension: " +
        "the setting Output folder). The user can set it to an existing folder in the MCP " +
        "client configuration and restart the server",
    );
  }
  return resolveOutputDir(outputDir);
}

/** `writeNewFile` into the output folder, with file system failures as trusted refusals. */
async function saveLocal(outputDir: string | undefined, file: OutputFile): Promise<string> {
  const directory = await outputDirectory(outputDir);
  try {
    return await writeNewFile(directory, file.filename, file.bytes);
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? ` (${error.code.replace(/[^A-Z0-9_]/g, "")})`
        : "";
    throw new SevdeskError({
      kind: "validation",
      message: `The file could not be saved in SEVDESK_OUTPUT_DIR${code}.`,
      cause: error,
    });
  }
}

function kindLabel(kind: LocalFileKind): string {
  return kind.toUpperCase();
}

/** An upload's (already cleaned) name for messages, sanitized and quoted. */
function shownName(name: string): string {
  return JSON.stringify(sanitizeUntrusted(name, 80));
}

function refusal(reason: string): SevdeskError {
  return new SevdeskError({ kind: "validation", message: `${reason}. ${NOTHING_SENT}` });
}
