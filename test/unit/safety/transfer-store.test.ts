import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RequestPrincipal } from "../../../src/accounts/types.js";
import type { AuditLog, FileAuditEvent } from "../../../src/safety/audit.js";
import { type BlobStore, openBlobStore } from "../../../src/safety/blob-store.js";
import {
  accountShare,
  createTransferStore,
  duration,
  type FileTransferStore,
  MAX_UPLOAD_BYTES,
  megabytes,
  type TransferStoreOptions,
} from "../../../src/safety/transfer-store.js";
import { TransferLimitError } from "../../../src/safety/transfer-types.js";
import { fakeClock } from "../../helpers/remote-approvals.js";

const MB = 1024 * 1024;
const A1: RequestPrincipal = { grantKey: "grant-a1", accountScope: "1001" };
const A2: RequestPrincipal = { grantKey: "grant-a2", accountScope: "1001" };
const B: RequestPrincipal = { grantKey: "grant-b", accountScope: "2002" };
const PDF = Buffer.from("%PDF-1.7\nBeleg 4711\n%%EOF");

const stores: FileTransferStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

interface Setup {
  readonly store: FileTransferStore;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly audited: FileAuditEvent[];
  readonly blobs: BlobStore;
}

async function setup(overrides: Partial<TransferStoreOptions> = {}): Promise<Setup> {
  const clock = fakeClock();
  const audited: FileAuditEvent[] = [];
  const audit: AuditLog = {
    enabled: true,
    record: (event) => {
      audited.push(event as FileAuditEvent);
      return Promise.resolve();
    },
  };
  const blobs = overrides.blobs ?? (await openBlobStore());
  const store = createTransferStore({
    blobs,
    maxBytes: 64 * MB,
    fileTtlMs: 30 * 60_000,
    now: clock.now,
    audit,
    pruneIntervalMs: 0,
    ...overrides,
  });
  stores.push(store);
  return { store, clock, audited, blobs };
}

function file(bytes: Uint8Array = PDF, name = "Beleg_4711.pdf") {
  return { name, kind: "pdf" as const, bytes };
}

describe("transfer store: uploads", () => {
  it("opens a ticket, receives the file once and hands it to the same grant only", async () => {
    const { store, audited } = await setup();
    const ticket = store.createTicket(A1, "receipt");
    expect(ticket).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      reference: expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/) as unknown,
      purpose: "receipt",
      kinds: ["pdf", "png", "jpeg"],
      maxBytes: MAX_UPLOAD_BYTES,
      expiresAt: "2026-11-09T12:15:00.000Z",
    });
    expect(await store.readUpload(A1, ticket.id)).toBeUndefined();
    expect(store.ticketFor(ticket.id, "1001")).toMatchObject({ status: "pending" });

    const outcome = await store.receive(ticket.id, "1001", file());
    expect(outcome).toEqual({
      status: "received",
      ticket: expect.objectContaining({
        status: "uploaded",
        accountId: "1001",
        expiresAt: "2026-11-09T12:30:00.000Z",
        file: {
          name: "Beleg_4711.pdf",
          kind: "pdf",
          size: PDF.byteLength,
          sha256: createHash("sha256").update(PDF).digest("hex"),
        },
      }) as unknown,
    });
    expect(await store.receive(ticket.id, "1001", file())).toEqual({
      status: "already_received",
    });

    const read = await store.readUpload(A1, ticket.id);
    expect(read).toEqual({ name: "Beleg_4711.pdf", kind: "pdf", bytes: PDF, source: "upload" });
    // Reading does not consume: a failed write can be retried.
    expect(await store.readUpload(A1, ticket.id)).toEqual(read);
    // Another grant of the same account, and another account, see nothing.
    expect(await store.readUpload(A2, ticket.id)).toBeUndefined();
    expect(await store.readUpload(B, ticket.id)).toBeUndefined();

    expect(audited).toEqual([
      {
        event: "file_received",
        account: "1001",
        grant: "grant-a1",
        reference: ticket.reference,
        kind: "pdf",
        bytes: PDF.byteLength,
        sha256: createHash("sha256").update(PDF).digest("hex"),
      },
    ]);
  });

  it("releases only an uploaded file of the same grant and account, including its blob", async () => {
    const { store, blobs } = await setup({ maxRecordsPerAccount: 3 });
    const put = vi.spyOn(blobs, "put");
    const deleted = vi.spyOn(blobs, "delete");
    const ticket = store.createTicket(A1, "receipt");
    const pending = store.createTicket(A1, "receipt");
    const link = await store.createDownload(A1, { filename: "a.pdf", kind: "pdf", bytes: PDF });
    await store.receive(ticket.id, "1001", file());
    const blobId: unknown = await put.mock.results[1]?.value;
    expect(blobId).toBeDefined();
    for (const owner of [A2, B, { ...A1, accountScope: B.accountScope }]) {
      store.releaseUpload(owner, ticket.id);
    }
    for (const id of [pending.id, link.id, "unknown"]) store.releaseUpload(A1, id);
    expect(deleted).not.toHaveBeenCalled();
    expect(store.usage()).toEqual({ records: 3, bytes: 2 * PDF.byteLength });
    expect(() => store.createTicket(A1, "receipt")).toThrow(TransferLimitError);

    store.releaseUpload(A1, ticket.id);
    store.releaseUpload(A1, ticket.id); // Idempotent, including concurrent successful consumers.
    expect(deleted).toHaveBeenCalledExactlyOnceWith(blobId);
    if (typeof blobId !== "string") throw new Error("missing test blob");
    expect(await blobs.get(blobId, { accountScope: "1001", kind: "pdf" })).toBeUndefined();
    expect(await store.readUpload(A1, ticket.id)).toBeUndefined();
    expect(store.ticketFor(ticket.id, "1001")).toBeUndefined();
    expect(await store.receive(ticket.id, "1001", file())).toEqual({ status: "unknown" });
    expect(store.usage()).toEqual({ records: 2, bytes: PDF.byteLength });
    expect(store.createTicket(A1, "receipt").id).toBeDefined();
  });

  it("does not release a receiving ticket", async () => {
    const real = await openBlobStore();
    const blobs: BlobStore = {
      ...real,
      put(binding, bytes) {
        store.releaseUpload(A1, ticket.id);
        expect(() => store.createTicket(A1, "receipt")).toThrow(
          "No expiry is available for this account yet",
        );
        expect(store.ticketFor(ticket.id, "1001")).toMatchObject({ status: "receiving" });
        return real.put(binding, bytes);
      },
    };
    const { store } = await setup({ blobs, maxRecordsPerAccount: 1 });
    const ticket = store.createTicket(A1, "receipt");
    expect(await store.receive(ticket.id, "1001", file())).toMatchObject({ status: "received" });
  });

  it("reports the earliest account expiry, including tickets and links but never other accounts", async () => {
    const { store, clock } = await setup({ maxRecordsPerAccount: 3 });
    const foreign = store.createTicket(B, "receipt"); // 12:15, must not be disclosed.
    clock.advance(60_000);
    const uploaded = store.createTicket(A1, "receipt");
    await store.receive(uploaded.id, "1001", file()); // 12:31
    const link = await store.createDownload(A2, { filename: "a.pdf", kind: "pdf", bytes: PDF });
    clock.advance(60_000);
    const pending = store.createTicket(A1, "receipt"); // 12:17, earliest of this account.
    const expected = `The next expiry for this account is ${pending.expiresAt}.`;
    expect(() => store.createTicket(A1, "receipt")).toThrow(expected);
    await expect(
      store.createDownload(A1, { filename: "a.pdf", kind: "pdf", bytes: PDF }),
    ).rejects.toThrow(expected);
    try {
      store.createTicket(A1, "receipt");
    } catch (error) {
      expect(error).toBeInstanceOf(TransferLimitError);
      if (!(error instanceof Error)) throw error;
      expect(error.message).not.toContain(foreign.expiresAt);
    }
    clock.advance(15 * 60_000);
    expect(store.createTicket(A1, "receipt").id).toBeDefined();
    expect(() => store.createTicket(A1, "receipt")).toThrow(link.expiresAt);
  });

  it("reports the earliest pending expiry and prunes it at the boundary", async () => {
    const { store, clock } = await setup({ maxPendingPerAccount: 2 });
    const first = store.createTicket(A1, "receipt");
    clock.advance(60_000);
    store.createTicket(A1, "receipt");
    expect(() => store.createTicket(A1, "receipt")).toThrow(first.expiresAt);
    clock.advance(14 * 60_000);
    expect(store.createTicket(A1, "receipt").id).toBeDefined();
  });

  it("does not disclose foreign expiries at the global cap", async () => {
    const { store } = await setup({ maxRecords: 1 });
    const foreign = store.createTicket(B, "receipt");
    expect(() => store.createTicket(A1, "receipt")).toThrow(
      "No expiry is available for this account yet",
    );
    try {
      store.createTicket(A1, "receipt");
    } catch (error) {
      expect(error).toBeInstanceOf(TransferLimitError);
      if (!(error instanceof Error)) throw error;
      expect(error.message).not.toContain(foreign.expiresAt);
    }
    expect(() => store.createTicket(B, "receipt")).toThrow(foreign.expiresAt);
  });

  it("counts in-flight downloads without inventing an expiry", async () => {
    const real = await openBlobStore();
    const blobs: BlobStore = {
      ...real,
      put(binding, bytes) {
        expect(() => store.createTicket(A1, "receipt")).toThrow(
          "No expiry is available for this account yet",
        );
        return real.put(binding, bytes);
      },
    };
    const { store } = await setup({ blobs, maxRecordsPerAccount: 1 });
    const link = await store.createDownload(A1, { filename: "a.pdf", kind: "pdf", bytes: PDF });
    expect(() => store.createTicket(A1, "receipt")).toThrow(link.expiresAt);
  });

  it("shows and accepts a ticket only for its account; foreign looks unknown", async () => {
    const { store } = await setup();
    const ticket = store.createTicket(A1, "einvoice");
    expect(ticket.kinds).toEqual(["xml", "pdf"]);
    expect(store.ticketFor(ticket.id, "2002")).toBeUndefined();
    expect(store.ticketFor("x".repeat(43), "1001")).toBeUndefined();
    expect(await store.receive(ticket.id, "2002", file())).toEqual({ status: "unknown" });
    // The other grant's browser session of the same account may upload (pages are per account).
    expect(store.ticketFor(ticket.id, "1001")).toMatchObject({ purpose: "einvoice" });
  });

  it("refuses a kind the ticket does not take and a file over its limit", async () => {
    const { store } = await setup({ maxUploadBytes: 100 });
    const ticket = store.createTicket(A1, "einvoice");
    expect(ticket.maxBytes).toBe(100);
    expect(
      await store.receive(ticket.id, "1001", { name: "x.png", kind: "png", bytes: PDF }),
    ).toEqual({ status: "wrong_kind" });
    expect(await store.receive(ticket.id, "1001", file(new Uint8Array(101)))).toEqual({
      status: "too_large",
    });
    expect(store.ticketFor(ticket.id, "1001")).toMatchObject({ status: "pending" });
  });

  it("claims the ticket before writing, so a concurrent second upload is refused", async () => {
    const { store } = await setup();
    const ticket = store.createTicket(A1, "receipt");
    const [first, second] = await Promise.all([
      store.receive(ticket.id, "1001", file()),
      store.receive(ticket.id, "1001", file()),
    ]);
    expect(first.status).toBe("received");
    expect(second).toEqual({ status: "already_received" });
  });

  it("puts the ticket back when the write fails", async () => {
    const real = await openBlobStore();
    const blobs: BlobStore = {
      ...real,
      put: vi.fn<BlobStore["put"]>().mockRejectedValueOnce(new Error("disk full")),
    };
    const { store } = await setup({ blobs });
    const ticket = store.createTicket(A1, "receipt");
    await expect(store.receive(ticket.id, "1001", file())).rejects.toThrow("disk full");
    expect(store.ticketFor(ticket.id, "1001")).toMatchObject({ status: "pending" });
    expect(store.usage()).toEqual({ bytes: 0, records: 1 });
  });

  it("expires unused tickets after 15 minutes and uploads after the file lifetime", async () => {
    const { store, clock } = await setup();
    const unused = store.createTicket(A1, "receipt");
    const used = store.createTicket(A1, "receipt");
    clock.advance(14 * 60_000);
    await store.receive(used.id, "1001", file());
    clock.advance(60_000);
    expect(store.ticketFor(unused.id, "1001")).toBe("expired");
    expect(store.ticketFor(unused.id, "2002")).toBeUndefined();
    expect(await store.receive(unused.id, "1001", file())).toEqual({ status: "expired" });
    expect(await store.readUpload(A1, used.id)).toBeDefined();
    clock.advance(29 * 60_000);
    expect(await store.readUpload(A1, used.id)).toBeUndefined();
    expect(store.ticketFor(used.id, "1001")).toBe("expired");
    expect(store.usage()).toEqual({ bytes: 0, records: 0 });
    // The marker itself goes after an hour.
    clock.advance(60 * 60_000);
    expect(store.ticketFor(used.id, "1001")).toBeUndefined();
  });

  it("keeps a ticket whose file is being written when it expires meanwhile", async () => {
    const clock = fakeClock();
    const real = await openBlobStore();
    const holder: { store?: FileTransferStore } = {};
    const blobs: BlobStore = {
      ...real,
      async put(binding, bytes) {
        clock.advance(16 * 60_000);
        holder.store?.usage(); // prunes
        return real.put(binding, bytes);
      },
    };
    const { store } = await setup({ blobs, now: clock.now });
    holder.store = store;
    const ticket = store.createTicket(A1, "receipt");
    expect(await store.receive(ticket.id, "1001", file())).toMatchObject({
      status: "received",
      ticket: { expiresAt: "2026-11-09T12:46:00.000Z" },
    });
  });

  it("drops the blob of an upload that finishes after the store closed", async () => {
    const real = await openBlobStore();
    const deleted: string[] = [];
    const holder: { close?: Promise<void> } = {};
    const blobs: BlobStore = {
      ...real,
      async put(binding, bytes) {
        const id = await real.put(binding, bytes);
        holder.close = store.close();
        return id;
      },
      delete(id) {
        deleted.push(id);
        return real.delete(id);
      },
    };
    const { store } = await setup({ blobs });
    const ticket = store.createTicket(A1, "receipt");
    expect(await store.receive(ticket.id, "1001", file())).toEqual({ status: "expired" });
    await holder.close;
    expect(deleted).toHaveLength(1);
  });

  it("limits waiting tickets to 5 and records to 10 per account, never touching others", async () => {
    const { store } = await setup();
    const tickets = Array.from({ length: 5 }, () => store.createTicket(A1, "receipt"));
    expect(() => store.createTicket(A2, "receipt")).toThrow(TransferLimitError);
    expect(() => store.createTicket(A1, "receipt")).toThrow(/5 upload requests/);
    // Another account is unaffected.
    expect(store.createTicket(B, "receipt").id).toBeDefined();
    for (const ticket of tickets) await store.receive(ticket.id, "1001", file());
    for (let index = 0; index < 4; index += 1) store.createTicket(A1, "receipt");
    await store.createDownload(A1, { filename: "a.pdf", kind: "pdf", bytes: PDF });
    expect(() => store.createTicket(A1, "receipt")).toThrow(/already has 10 uploads/);
    await expect(
      store.createDownload(A2, { filename: "a.pdf", kind: "pdf", bytes: PDF }),
    ).rejects.toThrow(TransferLimitError);
    // Nothing of account 1001 was evicted for the refusals.
    for (const ticket of tickets) expect(await store.readUpload(A1, ticket.id)).toBeDefined();
  });

  it("refuses new records beyond the overall cap", async () => {
    const { store } = await setup({ maxRecords: 2 });
    store.createTicket(A1, "receipt");
    store.createTicket(B, "receipt");
    expect(() => store.createTicket({ grantKey: "c", accountScope: "3003" }, "receipt")).toThrow(
      /too many uploads and download links/,
    );
  });

  it("caps an upload at the account's share and refuses one that does not fit", async () => {
    const { store } = await setup({ maxBytes: 2_000 });
    const ticket = store.createTicket(A1, "receipt");
    expect(ticket.maxBytes).toBe(1_000);
    await store.createDownload(A1, { filename: "a.pdf", kind: "pdf", bytes: new Uint8Array(900) });
    expect(await store.receive(ticket.id, "1001", file(new Uint8Array(200)))).toEqual({
      status: "storage_full",
    });
    expect(store.ticketFor(ticket.id, "1001")).toMatchObject({ status: "pending" });
  });
});

describe("transfer store: download links", () => {
  it("stores a file and serves it 5 times to the account's sessions", async () => {
    const { store, audited } = await setup();
    const link = await store.createDownload(A1, {
      filename: "RE-1001.pdf",
      kind: "pdf",
      bytes: PDF,
    });
    expect(link).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      reference: expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/) as unknown,
      filename: "RE-1001.pdf",
      kind: "pdf",
      mimeType: "application/pdf",
      bytes: PDF.byteLength,
      expiresAt: "2026-11-09T12:30:00.000Z",
    });
    expect(await store.takeDownload(link.id, "2002")).toEqual({ status: "unknown" });
    for (let index = 0; index < 5; index += 1) {
      expect(await store.takeDownload(link.id, "1001")).toEqual({
        status: "served",
        file: { reference: link.reference, filename: "RE-1001.pdf", kind: "pdf", bytes: PDF },
      });
    }
    expect(await store.takeDownload(link.id, "1001")).toEqual({ status: "exhausted" });
    expect(await store.takeDownload(link.id, "2002")).toEqual({ status: "unknown" });
    expect(store.usage()).toEqual({ bytes: 0, records: 0 });
    expect(audited.map((event) => event.event)).toEqual([
      "file_link_created",
      ...Array<string>(5).fill("file_downloaded"),
    ]);
    expect(audited[0]).toMatchObject({ account: "1001", grant: "grant-a1", bytes: PDF.length });
  });

  it("counts concurrent downloads before reading, never serving more than 5", async () => {
    const { store } = await setup();
    const link = await store.createDownload(A1, { filename: "a.csv", kind: "csv", bytes: PDF });
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => store.takeDownload(link.id, "1001")),
    );
    expect(outcomes.filter((outcome) => outcome.status === "served")).toHaveLength(5);
    expect(outcomes.filter((outcome) => outcome.status === "exhausted")).toHaveLength(3);
  });

  it("expires links after the file lifetime", async () => {
    const { store, clock } = await setup({ fileTtlMs: 5 * 60_000 });
    const link = await store.createDownload(A1, { filename: "a.zip", kind: "zip", bytes: PDF });
    expect(link.mimeType).toBe("application/zip");
    clock.advance(5 * 60_000);
    expect(await store.takeDownload(link.id, "1001")).toEqual({ status: "expired" });
  });

  it("refuses a file larger than an account's share and space that is taken", async () => {
    const { store } = await setup({ maxBytes: 1_000 });
    await expect(
      store.createDownload(A1, { filename: "big.zip", kind: "zip", bytes: new Uint8Array(501) }),
    ).rejects.toThrow(/more than this server holds for one sevDesk account/);
    await store.createDownload(A1, { filename: "a.zip", kind: "zip", bytes: new Uint8Array(400) });
    await expect(
      store.createDownload(A1, { filename: "b.zip", kind: "zip", bytes: new Uint8Array(200) }),
    ).rejects.toThrow(/space for download links is full/);
    // Account B, holding nothing, may still use the room kept for newcomers.
    await store.createDownload(B, { filename: "c.zip", kind: "zip", bytes: new Uint8Array(500) });
    await expect(
      store.createDownload(
        { grantKey: "c", accountScope: "3003" },
        {
          filename: "d.zip",
          kind: "zip",
          bytes: new Uint8Array(200),
        },
      ),
    ).rejects.toThrow(TransferLimitError);
  });

  it("gives each account a quarter and keeps one upload's room for accounts holding nothing", async () => {
    const { store } = await setup({ maxBytes: 4_000, maxUploadBytes: 1_000 });
    const owner = (account: string): RequestPrincipal => ({
      grantKey: `grant-${account}`,
      accountScope: account,
    });
    const link = (account: string, size: number) =>
      store.createDownload(owner(account), {
        filename: "a.zip",
        kind: "zip",
        bytes: new Uint8Array(size),
      });
    await link("a", 1_000);
    await expect(link("a", 1)).rejects.toThrow(/space for download links is full/);
    await link("b", 600);
    await link("c", 600);
    await link("b", 400);
    await link("c", 400);
    // 3,000 held: accounts that hold files may not use the last 1,000 ...
    await link("d", 700);
    await expect(link("d", 100)).rejects.toThrow(TransferLimitError);
    // ... but an account holding nothing may, also for an upload.
    const ticket = store.createTicket(owner("e"), "receipt");
    expect(ticket.maxBytes).toBe(1_000);
    expect(await store.receive(ticket.id, "e", file(new Uint8Array(400)))).toEqual({
      status: "storage_full",
    });
    expect(await store.receive(ticket.id, "e", file(new Uint8Array(300)))).toMatchObject({
      status: "received",
    });
    await expect(link("f", 1)).rejects.toThrow(TransferLimitError);
    expect(store.usage()).toEqual({ bytes: 4_000, records: 7 });
  });

  it("sizes the share: a quarter, at least one largest upload, at most half", () => {
    expect(accountShare(256 * MB, MAX_UPLOAD_BYTES)).toBe(64 * MB);
    expect(accountShare(64 * MB, MAX_UPLOAD_BYTES)).toBe(20 * MB);
    expect(accountShare(32 * MB, MAX_UPLOAD_BYTES)).toBe(16 * MB);
    expect(accountShare(4_000, 1_000)).toBe(1_000);
  });

  it("reserves space while a blob is written, so parallel links cannot overshoot", async () => {
    const { store } = await setup({ maxBytes: 1_000 });
    const results = await Promise.allSettled([
      store.createDownload(A1, { filename: "a.zip", kind: "zip", bytes: new Uint8Array(300) }),
      store.createDownload(A1, { filename: "b.zip", kind: "zip", bytes: new Uint8Array(300) }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  });

  it("answers expired when the blob is gone", async () => {
    const real = await openBlobStore();
    const blobs: BlobStore = { ...real, get: () => Promise.resolve(undefined) };
    const { store } = await setup({ blobs });
    const link = await store.createDownload(A1, { filename: "a.pdf", kind: "pdf", bytes: PDF });
    expect(await store.takeDownload(link.id, "1001")).toEqual({ status: "expired" });
  });
});

describe("transfer store: lifecycle", () => {
  it("prunes in the background and stops on close", async () => {
    vi.useFakeTimers();
    try {
      const clock = fakeClock();
      const { store, blobs } = await setup({ pruneIntervalMs: 60_000, now: clock.now });
      const deleted = vi.spyOn(blobs, "delete");
      const link = await store.createDownload(A1, { filename: "a.pdf", kind: "pdf", bytes: PDF });
      clock.advance(31 * 60_000);
      vi.advanceTimersByTime(60_000);
      expect(deleted).toHaveBeenCalledTimes(1);
      await store.close();
      expect(vi.getTimerCount()).toBe(0);
      expect(await store.takeDownload(link.id, "1001")).toEqual({ status: "unknown" });
      expect(() => store.createTicket(A1, "receipt")).toThrow(/closed/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports audit failures without failing the transfer", async () => {
    const failures: string[] = [];
    const { store } = await setup({
      audit: { enabled: true, record: () => Promise.reject(new Error("audit down")) },
      onAuditError: (event) => {
        failures.push(event);
        throw new Error("reporter broken too");
      },
    });
    const link = await store.createDownload(A1, { filename: "a.pdf", kind: "pdf", bytes: PDF });
    expect(link.reference).toHaveLength(6);
    await new Promise((resolve) => setImmediate(resolve));
    expect(failures).toEqual(["file_link_created"]);
  });

  it("validates its budget", async () => {
    const blobs = await openBlobStore();
    expect(() => createTransferStore({ blobs, maxBytes: 0, fileTtlMs: 1 })).toThrow(RangeError);
  });

  it("formats durations and sizes for messages", () => {
    expect(duration(30 * 60_000)).toBe("30 minutes");
    expect(duration(60_000)).toBe("1 minute");
    expect(duration(3_600_000)).toBe("1 hour");
    expect(duration(2 * 3_600_000)).toBe("2 hours");
    expect(duration(90_000)).toBe("90 seconds");
    expect(megabytes(20 * MB)).toBe("20 MB");
    expect(megabytes(1.5 * MB)).toBe("1.5 MB");
  });
});
