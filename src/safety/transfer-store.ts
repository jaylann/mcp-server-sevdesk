/**
 * The records of remote file transfer (HTTP mode with `SEVDESK_HTTP_FILES`): upload tickets the
 * human fills on `/uploads/<id>`, and download links tools hand out, served on `/files/<id>`.
 * Implements the tool side ({@link TransferStore}) and the browser side the pages use
 * (`src/http/transfer-routes.ts`). Modelled on `approval-store.ts`.
 *
 * Records live in memory only; their bytes go to a {@link BlobStore} (memory or the state
 * directory, encrypted with a per-process key). A restart voids every ticket, upload and link.
 *
 * Ownership (see {@link RequestPrincipal}):
 * - tools read only uploads of their own grant and account ({@link TransferStore.readUpload});
 * - pages show, accept and serve only records of the browser session's account
 *   ({@link FileTransferStore.ticketFor}, {@link FileTransferStore.receive},
 *   {@link FileTransferStore.takeDownload}); a record of another account looks exactly like an
 *   unknown id.
 *
 * Lifetimes: a ticket can be used for 15 minutes; an uploaded file and a download link live for
 * `fileTtlMs` (`SEVDESK_HTTP_FILES_TTL`); a link serves at most 5 downloads. Expired records are
 * pruned on every call and once a minute, their blobs deleted; a short-lived marker (one hour)
 * lets the pages say "expired" instead of "not found".
 *
 * Limits, so no account can crowd out another (nothing is ever evicted; new records are refused
 * with {@link TransferLimitError} instead):
 * - 5 tickets waiting for a file per account, 10 live records per account, 1,000 overall;
 * - bytes: one account holds at most half of `maxBytes` (`SEVDESK_HTTP_FILES_MAX_MB`), all
 *   accounts together at most `maxBytes`; one upload at most 20 MiB (or the account's half).
 *
 * Ids are 256-bit random (`randomId`); references are 6-character codes for humans. Neither is
 * ever logged; file names are kept cleaned (the routes clean them) and never used as paths.
 */
import { createHash, randomInt } from "node:crypto";

import type { RequestPrincipal } from "../accounts/types.js";
import { type AuditLog, auditPrincipal, type FileAuditEvent } from "./audit.js";
import type { BlobStore } from "./blob-store.js";
import type { InputFile, OutputFile, OutputFileKind } from "./file-access.js";
import type { LocalFileKind } from "./local-files.js";
import {
  type DownloadLinkView,
  TransferLimitError,
  type TransferStore,
  UPLOAD_KINDS,
  type UploadPurpose,
  type UploadTicketView,
} from "./transfer-types.js";
import { randomId } from "./web.js";

/** What an upload page shows of a ticket: trusted values only (nothing the model wrote). */
export interface UploadTicketState {
  readonly id: string;
  readonly reference: string;
  readonly purpose: UploadPurpose;
  readonly kinds: readonly LocalFileKind[];
  readonly maxBytes: number;
  /** The account the ticket belongs to. */
  readonly accountId: string;
  /** ISO 8601: until a file is uploaded, the ticket's expiry; after, the file's. */
  readonly expiresAt: string;
  readonly status: "pending" | "receiving" | "uploaded";
  /** Set once uploaded. `name` is the cleaned name; escape it before display. */
  readonly file?: {
    readonly name: string;
    readonly kind: LocalFileKind;
    readonly size: number;
    readonly sha256: string;
  };
}

/** @public A file the human uploaded, already cleaned and checked by the route. */
export interface ReceivedFile {
  /** Cleaned base name (never a path). */
  readonly name: string;
  readonly kind: LocalFileKind;
  readonly bytes: Uint8Array;
}

/** @public Result of {@link FileTransferStore.receive}. */
export type ReceiveOutcome =
  | { readonly status: "received"; readonly ticket: UploadTicketState }
  | {
      readonly status:
        "unknown" | "expired" | "already_received" | "wrong_kind" | "too_large" | "storage_full";
    };

/** A file served for a download link. */
export interface ServedDownload {
  readonly reference: string;
  /** Built by the tool from its own values; still encode it for the header. */
  readonly filename: string;
  readonly kind: OutputFileKind;
  readonly bytes: Uint8Array;
}

/** @public Result of {@link FileTransferStore.takeDownload}. */
export type TakeOutcome =
  | { readonly status: "served"; readonly file: ServedDownload }
  | { readonly status: "unknown" | "expired" | "exhausted" };

/** The browser side of the store, on top of the tool side. */
export interface FileTransferStore extends TransferStore {
  /**
   * Ticket `id` as its page shows it, when it belongs to `accountId`; `"expired"` when it did and
   * expired recently; `undefined` otherwise (unknown and foreign look the same).
   */
  ticketFor(id: string, accountId: string): UploadTicketState | "expired" | undefined;
  /**
   * Stores the file of ticket `id` for the session's `accountId`. The ticket is marked
   * `receiving` before the first `await`, so a concurrent second upload gets
   * `already_received`. A failed write puts the ticket back to `pending` and rejects.
   */
  receive(id: string, accountId: string, file: ReceivedFile): Promise<ReceiveOutcome>;
  /**
   * Counts one download of link `id` for the session's `accountId` and returns its bytes. The
   * count drops before the first `await`; the last allowed download removes the link.
   */
  takeDownload(id: string, accountId: string): Promise<TakeOutcome>;
  /** Bytes and records held now (tests and diagnostics). */
  usage(): { readonly bytes: number; readonly records: number };
  /** Stops the pruning timer, forgets every record and deletes the blobs. */
  close(): Promise<void>;
}

export interface TransferStoreOptions {
  readonly blobs: BlobStore;
  /** Most bytes held at once, all accounts together; one account may hold half. */
  readonly maxBytes: number;
  /** Lifetime of an uploaded file and of a download link (ms). */
  readonly fileTtlMs: number;
  /** Lifetime of an unused upload ticket (default 15 minutes). */
  readonly ticketTtlMs?: number;
  /** Largest upload (default 20 MiB; never more than an account's half of `maxBytes`). */
  readonly maxUploadBytes?: number;
  /** Tickets waiting for a file per account (default 5). */
  readonly maxPendingPerAccount?: number;
  /** Live tickets and links per account (default 10). */
  readonly maxRecordsPerAccount?: number;
  /** Live tickets and links overall (default 1,000). */
  readonly maxRecords?: number;
  /** Downloads one link serves (default 5). */
  readonly maxDownloads?: number;
  /** Epoch milliseconds (default `Date.now`). */
  readonly now?: () => number;
  /** Receives `file_received`, `file_link_created` and `file_downloaded`. */
  readonly audit?: AuditLog;
  /** Called when an audit line could not be written (best effort; default: ignored). */
  readonly onAuditError?: (event: FileAuditEvent["event"]) => void;
  /** How often expired records are pruned in the background (default 60 s; 0: never). */
  readonly pruneIntervalMs?: number;
}

/** Largest upload by default: 20 MiB. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_TICKET_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_PENDING = 5;
const DEFAULT_MAX_PER_ACCOUNT = 10;
const DEFAULT_MAX_RECORDS = 1_000;
const DEFAULT_MAX_DOWNLOADS = 5;
const DEFAULT_PRUNE_INTERVAL_MS = 60_000;
/** How long an expired or used-up record is remembered as such. */
const MARKER_TTL_MS = 60 * 60 * 1000;
const MAX_MARKERS = 1_000;
/** The media type of each kind of file tools hand out (the download's `Content-Type`). */
export const MIME_TYPES: Readonly<Record<OutputFileKind, string>> = {
  pdf: "application/pdf",
  xml: "application/xml",
  csv: "text/csv",
  zip: "application/zip",
};
/** Reference codes: no 0/O, 1/I (as approval references). */
const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REFERENCE_LENGTH = 6;

interface StoredFile {
  readonly name: string;
  readonly kind: LocalFileKind;
  readonly size: number;
  readonly sha256: string;
  readonly blobId: string;
}

interface TicketRecord {
  readonly type: "ticket";
  readonly id: string;
  readonly owner: RequestPrincipal;
  readonly reference: string;
  readonly purpose: UploadPurpose;
  readonly kinds: readonly LocalFileKind[];
  readonly maxBytes: number;
  expiresAtMs: number;
  status: "pending" | "receiving" | "uploaded";
  /** Bytes reserved while receiving, held once uploaded. */
  size: number;
  file: StoredFile | undefined;
}

interface LinkRecord {
  readonly type: "link";
  readonly id: string;
  readonly owner: RequestPrincipal;
  readonly reference: string;
  readonly filename: string;
  readonly kind: OutputFileKind;
  readonly size: number;
  readonly sha256: string;
  readonly blobId: string;
  readonly expiresAtMs: number;
  downloadsLeft: number;
}

type TransferRecord = TicketRecord | LinkRecord;

/** What became of a record that is gone, for the pages' "expired" answers. */
interface Marker {
  readonly accountScope: string;
  readonly reason: "expired" | "exhausted";
  readonly untilMs: number;
}

/** Space claimed by a download link whose blob is being written. */
interface Reservation {
  readonly accountScope: string;
  readonly size: number;
}

export function createTransferStore(options: TransferStoreOptions): FileTransferStore {
  const { blobs, maxBytes, fileTtlMs } = options;
  if (!(maxBytes > 0) || !(fileTtlMs > 0)) {
    throw new RangeError("The transfer store needs a positive byte budget and file lifetime.");
  }
  const now = options.now ?? Date.now;
  const ticketTtlMs = options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
  const accountBytes = Math.floor(maxBytes / 2);
  const uploadBytes = Math.min(options.maxUploadBytes ?? MAX_UPLOAD_BYTES, accountBytes);
  const maxPending = options.maxPendingPerAccount ?? DEFAULT_MAX_PENDING;
  const maxPerAccount = options.maxRecordsPerAccount ?? DEFAULT_MAX_PER_ACCOUNT;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const maxDownloads = options.maxDownloads ?? DEFAULT_MAX_DOWNLOADS;
  const records = new Map<string, TransferRecord>();
  const markers = new Map<string, Marker>();
  const reservations = new Set<Reservation>();
  let closed = false;

  const intervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const timer =
    intervalMs > 0
      ? setInterval(() => {
          prune();
        }, intervalMs)
      : undefined;
  timer?.unref();

  function dropBlob(blobId: string | undefined): void {
    if (blobId !== undefined) void blobs.delete(blobId).catch(() => undefined);
  }

  function blobOf(record: TransferRecord): string | undefined {
    return record.type === "link" ? record.blobId : record.file?.blobId;
  }

  /** Removes `record`, deletes its blob and remembers why it went. */
  function remove(record: TransferRecord, reason: Marker["reason"]): void {
    if (records.get(record.id) !== record) return;
    records.delete(record.id);
    dropBlob(blobOf(record));
    markers.set(record.id, {
      accountScope: record.owner.accountScope,
      reason,
      untilMs: now() + MARKER_TTL_MS,
    });
    while (markers.size > MAX_MARKERS) {
      const oldest = markers.keys().next();
      if (oldest.done === true) break;
      markers.delete(oldest.value);
    }
  }

  function prune(): void {
    const at = now();
    for (const record of [...records.values()]) {
      // A ticket whose file is being written was used in time; its new lifetime starts after.
      if (record.type === "ticket" && record.status === "receiving") continue;
      if (record.expiresAtMs <= at) remove(record, "expired");
    }
    for (const [id, marker] of markers) {
      if (marker.untilMs <= at) markers.delete(id);
    }
  }

  function accountRecords(accountScope: string): TransferRecord[] {
    return [...records.values()].filter((record) => record.owner.accountScope === accountScope);
  }

  function bytesHeld(accountScope?: string): number {
    let total = 0;
    for (const record of records.values()) {
      if (accountScope === undefined || record.owner.accountScope === accountScope) {
        total += record.size;
      }
    }
    for (const reservation of reservations) {
      if (accountScope === undefined || reservation.accountScope === accountScope) {
        total += reservation.size;
      }
    }
    return total;
  }

  function reservedCount(accountScope?: string): number {
    return [...reservations].filter(
      (reservation) => accountScope === undefined || reservation.accountScope === accountScope,
    ).length;
  }

  /** Throws when `accountScope` may not create one more record. */
  function checkRecordLimits(accountScope: string): void {
    if (records.size + reservations.size >= maxRecords) {
      throw new TransferLimitError(
        "The server holds too many uploads and download links right now. Try again in a few " +
          "minutes, once older ones have expired.",
      );
    }
    if (accountRecords(accountScope).length + reservedCount(accountScope) >= maxPerAccount) {
      throw new TransferLimitError(
        `This sevDesk account already has ${String(maxPerAccount)} uploads and download links ` +
          `on the server. Older ones expire after ${duration(fileTtlMs)}; try again then.`,
      );
    }
  }

  /** Whether `size` more bytes fit for `accountScope` and overall. */
  function fits(accountScope: string, size: number): boolean {
    return bytesHeld(accountScope) + size <= accountBytes && bytesHeld() + size <= maxBytes;
  }

  function uniqueReference(): string {
    const used = new Set([...records.values()].map((record) => record.reference));
    for (;;) {
      const reference = referenceCode();
      if (!used.has(reference)) return reference;
    }
  }

  function ticketState(record: TicketRecord): UploadTicketState {
    const { file } = record;
    return {
      id: record.id,
      reference: record.reference,
      purpose: record.purpose,
      kinds: record.kinds,
      maxBytes: record.maxBytes,
      accountId: record.owner.accountScope,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      status: record.status,
      ...(file === undefined
        ? {}
        : { file: { name: file.name, kind: file.kind, size: file.size, sha256: file.sha256 } }),
    };
  }

  /** The record `id` of `type` when it belongs to `accountId`. */
  function owned<T extends TransferRecord["type"]>(
    id: string,
    accountId: string,
    type: T,
  ): Extract<TransferRecord, { type: T }> | undefined {
    const record = records.get(id);
    if (record?.type !== type || record.owner.accountScope !== accountId) return undefined;
    return record as Extract<TransferRecord, { type: T }>;
  }

  function markerFor(id: string, accountId: string): Marker["reason"] | undefined {
    const marker = markers.get(id);
    return marker?.accountScope === accountId ? marker.reason : undefined;
  }

  function audit(event: FileAuditEvent): void {
    if (options.audit === undefined) return;
    options.audit.record(event).catch(() => {
      try {
        options.onAuditError?.(event.event);
      } catch {
        // Reporting must never fail a transfer.
      }
    });
  }

  function assertOpen(): void {
    if (closed) throw new Error("The transfer store is closed.");
  }

  return {
    createTicket(owner, purpose) {
      assertOpen();
      prune();
      const scope = owner.accountScope;
      const waiting = accountRecords(scope).filter(
        (record) => record.type === "ticket" && record.status !== "uploaded",
      ).length;
      if (waiting >= maxPending) {
        throw new TransferLimitError(
          `${String(maxPending)} upload requests of this sevDesk account are still waiting for a ` +
            `file. Ask the user to use one of them; unused ones expire after ${duration(ticketTtlMs)}.`,
        );
      }
      checkRecordLimits(scope);
      const record: TicketRecord = {
        type: "ticket",
        id: randomId(),
        owner: { grantKey: owner.grantKey, accountScope: scope },
        reference: uniqueReference(),
        purpose,
        kinds: UPLOAD_KINDS[purpose],
        maxBytes: uploadBytes,
        expiresAtMs: now() + ticketTtlMs,
        status: "pending",
        size: 0,
        file: undefined,
      };
      records.set(record.id, record);
      return {
        id: record.id,
        reference: record.reference,
        purpose,
        kinds: record.kinds,
        maxBytes: record.maxBytes,
        expiresAt: new Date(record.expiresAtMs).toISOString(),
      } satisfies UploadTicketView;
    },

    async readUpload(owner, id): Promise<InputFile | undefined> {
      prune();
      const record = records.get(id);
      if (
        record?.type !== "ticket" ||
        record.status !== "uploaded" ||
        record.file === undefined ||
        !sameOwner(record.owner, owner)
      ) {
        return undefined;
      }
      const { file } = record;
      const bytes = await blobs.get(file.blobId, {
        accountScope: record.owner.accountScope,
        kind: file.kind,
      });
      if (bytes === undefined) return undefined;
      return { name: file.name, kind: file.kind, bytes, source: "upload" };
    },

    async createDownload(owner, file: OutputFile): Promise<DownloadLinkView> {
      assertOpen();
      prune();
      const scope = owner.accountScope;
      const size = file.bytes.byteLength;
      if (size > accountBytes) {
        throw new TransferLimitError(
          `The file has ${megabytes(size)}, more than this server holds for one sevDesk account ` +
            `(${megabytes(accountBytes)}, half of SEVDESK_HTTP_FILES_MAX_MB). Download it in ` +
            "sevDesk instead, or ask the server's operator to raise the limit.",
        );
      }
      checkRecordLimits(scope);
      if (!fits(scope, size)) {
        throw new TransferLimitError(
          "The server's space for download links is full right now. Try again once older links " +
            `have expired (after ${duration(fileTtlMs)}), or download the file in sevDesk.`,
        );
      }
      const reservation: Reservation = { accountScope: scope, size };
      reservations.add(reservation);
      let blobId: string;
      try {
        blobId = await blobs.put({ accountScope: scope, kind: file.kind }, file.bytes);
      } finally {
        reservations.delete(reservation);
      }
      if (closed) {
        dropBlob(blobId);
        throw new Error("The transfer store is closed.");
      }
      const record: LinkRecord = {
        type: "link",
        id: randomId(),
        owner: { grantKey: owner.grantKey, accountScope: scope },
        reference: uniqueReference(),
        filename: file.filename,
        kind: file.kind,
        size,
        sha256: sha256(file.bytes),
        blobId,
        expiresAtMs: now() + fileTtlMs,
        downloadsLeft: maxDownloads,
      };
      records.set(record.id, record);
      audit({
        event: "file_link_created",
        ...auditPrincipal(record.owner),
        reference: record.reference,
        kind: record.kind,
        bytes: size,
        sha256: record.sha256,
      });
      return {
        id: record.id,
        reference: record.reference,
        filename: record.filename,
        kind: record.kind,
        mimeType: MIME_TYPES[record.kind],
        bytes: size,
        expiresAt: new Date(record.expiresAtMs).toISOString(),
      };
    },

    ticketFor(id, accountId) {
      prune();
      const record = owned(id, accountId, "ticket");
      if (record !== undefined) return ticketState(record);
      return markerFor(id, accountId) === "expired" ? "expired" : undefined;
    },

    async receive(id, accountId, file): Promise<ReceiveOutcome> {
      assertOpen();
      prune();
      const record = owned(id, accountId, "ticket");
      if (record === undefined) {
        return { status: markerFor(id, accountId) === "expired" ? "expired" : "unknown" };
      }
      if (record.status !== "pending") return { status: "already_received" };
      if (!record.kinds.includes(file.kind)) return { status: "wrong_kind" };
      const size = file.bytes.byteLength;
      if (size > record.maxBytes) return { status: "too_large" };
      if (!fits(accountId, size)) return { status: "storage_full" };
      // Claimed before the first await: a concurrent upload for the same ticket is refused.
      record.status = "receiving";
      record.size = size;
      let blobId: string;
      try {
        blobId = await blobs.put({ accountScope: accountId, kind: file.kind }, file.bytes);
      } catch (error) {
        record.status = "pending";
        record.size = 0;
        throw error;
      }
      if (records.get(id) !== record) {
        // The store closed while the blob was written.
        dropBlob(blobId);
        return { status: "expired" };
      }
      record.file = {
        name: file.name,
        kind: file.kind,
        size,
        sha256: sha256(file.bytes),
        blobId,
      };
      record.status = "uploaded";
      record.expiresAtMs = now() + fileTtlMs;
      audit({
        event: "file_received",
        ...auditPrincipal(record.owner),
        reference: record.reference,
        kind: file.kind,
        bytes: size,
        sha256: record.file.sha256,
      });
      return { status: "received", ticket: ticketState(record) };
    },

    async takeDownload(id, accountId): Promise<TakeOutcome> {
      prune();
      const record = owned(id, accountId, "link");
      if (record === undefined) {
        const reason = markerFor(id, accountId);
        return { status: reason ?? "unknown" };
      }
      if (record.downloadsLeft <= 0) return { status: "exhausted" };
      // Counted before the first await, so concurrent requests cannot exceed the limit.
      record.downloadsLeft -= 1;
      const last = record.downloadsLeft === 0;
      const bytes = await blobs.get(record.blobId, {
        accountScope: record.owner.accountScope,
        kind: record.kind,
      });
      if (last) remove(record, "exhausted");
      if (bytes === undefined) return { status: "expired" };
      audit({
        event: "file_downloaded",
        ...auditPrincipal(record.owner),
        reference: record.reference,
        kind: record.kind,
        bytes: record.size,
        sha256: record.sha256,
      });
      return {
        status: "served",
        file: { reference: record.reference, filename: record.filename, kind: record.kind, bytes },
      };
    },

    usage() {
      prune();
      return { bytes: bytesHeld(), records: records.size };
    },

    async close() {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      records.clear();
      markers.clear();
      await blobs.close();
    },
  };
}

function sameOwner(a: RequestPrincipal, b: RequestPrincipal): boolean {
  return a.grantKey === b.grantKey && a.accountScope === b.accountScope;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function referenceCode(): string {
  return Array.from(
    { length: REFERENCE_LENGTH },
    () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)] ?? "A",
  ).join("");
}

/** `30 minutes`, `2 hours`, `90 seconds`: trusted text for messages. */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${String(hours)} hour${hours === 1 ? "" : "s"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${String(seconds)} seconds`;
}

/** `1.5 MB`, `20 MB` (MiB, one decimal when below 10). */
export function megabytes(bytes: number): string {
  const value = bytes / (1024 * 1024);
  const shown = value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
  return `${shown} MB`;
}
