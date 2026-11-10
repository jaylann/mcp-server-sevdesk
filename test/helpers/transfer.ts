/**
 * Remote file transfer for tool tests: a real transfer store (memory blobs, fake clock), the HTTP
 * deployment that turns file transfer on, and a stand-in for the human uploading a file on the
 * page (`receive`, as the upload route calls it). Close the store with {@link TransferFixture.close}
 * (or let {@link useTransfer} do it after each test).
 */
import { afterEach } from "vitest";

import type { RequestPrincipal } from "../../src/accounts/types.js";
import type { Config, Deployment } from "../../src/config.js";
import { openBlobStore } from "../../src/safety/blob-store.js";
import { type FileAccess, uploadRef } from "../../src/safety/file-access.js";
import { remoteFileAccess } from "../../src/safety/file-sources.js";
import type { LocalFileKind } from "../../src/safety/local-files.js";
import { createTransferStore, type FileTransferStore } from "../../src/safety/transfer-store.js";
import type { UploadPurpose } from "../../src/safety/transfer-types.js";
import { allEnabledConfig } from "./config.js";
import { fakeClock } from "./remote-approvals.js";

export const FILES_ORIGIN = "https://mcp.example.com";
/** Lifetime of uploaded files and download links in these tests: 30 minutes. */
const FILES_TTL_SECONDS = 1_800;
/** The principal of an OAuth grant on account 4711. */
export const OWNER: RequestPrincipal = { grantKey: "grant-1", accountScope: "4711" };

/** HTTP deployment with remote file transfer on (`SEVDESK_HTTP_FILES=on`). */
export function filesDeployment(auth: "oauth" | "bearer" = "oauth"): Deployment {
  return {
    kind: "http",
    auth,
    publicOrigin: FILES_ORIGIN,
    approvalsUrl: undefined,
    files: { ttlSeconds: FILES_TTL_SECONDS },
  };
}

/** HTTP deployment with remote file transfer off (`SEVDESK_HTTP_FILES=off`). */
export function filesOffDeployment(auth: "oauth" | "bearer" = "oauth"): Deployment {
  return { kind: "http", auth, publicOrigin: FILES_ORIGIN, approvalsUrl: undefined };
}

/** {@link allEnabledConfig} served over HTTP with file transfer, like an OAuth account config. */
export function filesConfig(overrides: Partial<Config> = {}): Config {
  return allEnabledConfig({
    deployment: filesDeployment(),
    account: { id: OWNER.accountScope },
    ...overrides,
  });
}

export interface TransferFixture {
  readonly store: FileTransferStore;
  readonly clock: ReturnType<typeof fakeClock>;
  /** The {@link FileAccess} a tool call of `principal` gets. */
  access(config?: Config, principal?: RequestPrincipal): FileAccess;
  /**
   * Opens a ticket for `principal` and uploads `bytes` as the human would; returns the reference
   * tools accept (`upload:<id>`).
   */
  upload(
    bytes: Uint8Array,
    options?: {
      readonly name?: string;
      readonly kind?: LocalFileKind;
      readonly purpose?: UploadPurpose;
      readonly principal?: RequestPrincipal;
    },
  ): Promise<string>;
  close(): Promise<void>;
}

async function transferFixture(): Promise<TransferFixture> {
  const clock = fakeClock();
  const store = createTransferStore({
    blobs: await openBlobStore(),
    maxBytes: 64 * 1024 * 1024,
    fileTtlMs: FILES_TTL_SECONDS * 1000,
    now: clock.now,
    pruneIntervalMs: 0,
  });
  return {
    store,
    clock,
    access: (config = filesConfig(), principal = OWNER) =>
      remoteFileAccess(config, store, principal),
    async upload(bytes, options = {}) {
      const principal = options.principal ?? OWNER;
      const ticket = store.createTicket(principal, options.purpose ?? "receipt");
      const outcome = await store.receive(ticket.id, principal.accountScope, {
        name: options.name ?? "Beleg-4711.pdf",
        kind: options.kind ?? "pdf",
        bytes,
      });
      if (outcome.status !== "received") throw new Error(`upload failed: ${outcome.status}`);
      return uploadRef(ticket.id);
    },
    close: () => store.close(),
  };
}

/** A {@link transferFixture} per test, closed after each test. */
export function useTransfer(): () => Promise<TransferFixture> {
  const open: TransferFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((fixture) => fixture.close()));
  });
  return async () => {
    const fixture = await transferFixture();
    open.push(fixture);
    return fixture;
  };
}
