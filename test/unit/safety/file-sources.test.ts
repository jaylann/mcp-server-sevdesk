import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RequestPrincipal } from "../../../src/accounts/types.js";
import { openBlobStore } from "../../../src/safety/blob-store.js";
import type { FileAccess } from "../../../src/safety/file-access.js";
import { localFileAccess, remoteFileAccess } from "../../../src/safety/file-sources.js";
import { createTransferStore } from "../../../src/safety/transfer-store.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { testConfig } from "../../helpers/config.js";
import {
  FILES_ORIGIN,
  filesConfig,
  filesDeployment,
  filesOffDeployment,
  OWNER,
  useTransfer,
} from "../../helpers/transfer.js";

const PDF = new TextEncoder().encode("%PDF-1.7\nBeleg 4711\n%%EOF");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const XML = new TextEncoder().encode('<?xml version="1.0"?><Invoice/>');
const RECEIPT = { maxBytes: 1_000_000, kinds: ["pdf", "png", "jpeg"] as const };
const EINVOICE = { maxBytes: 1_000_000, kinds: ["pdf", "xml"] as const };
const POSIX = process.platform !== "win32";

const openTransfer = useTransfer();
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sevdesk-file-sources-"));
  temporary.push(dir);
  return dir;
}

/** The rejection of `promise` (or of `run`), as a {@link SevdeskError}. */
async function refusal(promise: Promise<unknown> | (() => unknown)): Promise<SevdeskError> {
  let error: unknown;
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SevdeskError);
  expect(error).toMatchObject({ kind: "validation", status: undefined });
  return error as SevdeskError;
}

describe("localFileAccess: reading", () => {
  it("reads only inside SEVDESK_FILE_DIRS and says where the file came from", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "Beleg.pdf"), PDF);
    const files = localFileAccess({ fileDirs: [dir], outputDir: undefined });

    expect(files.canRead).toBe(true);
    expect(files.canDeliver).toBe(false);
    expect(await files.read("Beleg.pdf", RECEIPT)).toEqual({
      name: "Beleg.pdf",
      kind: "pdf",
      bytes: PDF,
      source: "local",
    });
    const outside = await refusal(files.read("/etc/hosts", RECEIPT));
    expect(outside.message).toContain("SEVDESK_FILE_DIRS");
  });

  it("refuses everything when no folder is configured", async () => {
    const files = localFileAccess({ fileDirs: [], outputDir: undefined });
    expect(files.canRead).toBe(false);
    expect((await refusal(files.read("Beleg.pdf", RECEIPT))).message).toContain(
      "SEVDESK_FILE_DIRS is not set",
    );
  });

  it.each([`upload:${"a".repeat(43)}`, "upload:short", "upload:"])(
    "refuses the upload reference %s with a hint, without touching the file system",
    async (ref) => {
      const dir = await tempDir();
      await writeFile(join(dir, "Beleg.pdf"), PDF);
      const files = localFileAccess({ fileDirs: [dir], outputDir: undefined });

      const error = await refusal(files.read(ref, RECEIPT));

      expect(error.message).toContain("sevdesk_upload_request");
      expect(error.message).toContain("./upload:");
      expect(error.message).toContain("SEVDESK_FILE_DIRS");
      expect(error.message).toMatch(/Nothing was sent to sevDesk\.$/);
      expect(error.message).not.toContain("a".repeat(43));
    },
  );

  it.runIf(POSIX)(
    "reads a local file literally named upload:… when passed as ./upload:…",
    async () => {
      const dir = await tempDir();
      await writeFile(join(dir, "upload:scan.pdf"), PDF);
      const files = localFileAccess({ fileDirs: [dir], outputDir: undefined });

      expect((await files.read("./upload:scan.pdf", RECEIPT)).name).toBe("upload:scan.pdf");
    },
  );

  it("offers no uploads", async () => {
    const files = localFileAccess({ fileDirs: [], outputDir: undefined });
    const error = await refusal(() => files.requestUpload("receipt"));
    expect(error.message).toContain("SEVDESK_HTTP_FILES");
  });
});

describe("localFileAccess: delivering", () => {
  it("writes a new file in SEVDESK_OUTPUT_DIR (0600), never overwriting", async () => {
    const dir = await tempDir();
    const files = localFileAccess({ fileDirs: [], outputDir: dir });
    const real = await realpath(dir);

    expect(files.canDeliver).toBe(true);
    await files.checkDelivery();
    const first = await files.deliver({ filename: "RE-1001.pdf", kind: "pdf", bytes: PDF });
    const second = await files.deliver({ filename: "RE-1001.pdf", kind: "pdf", bytes: PDF });

    expect(first).toEqual({ savedTo: join(real, "RE-1001.pdf") });
    expect(second).toEqual({ savedTo: join(real, "RE-1001-1.pdf") });
    expect(await readFile(join(real, "RE-1001.pdf"))).toEqual(Buffer.from(PDF));
    if (POSIX) expect((await stat(join(real, "RE-1001.pdf"))).mode & 0o777).toBe(0o600);
    expect(files.describeDelivery()).toBe(`a new file in SEVDESK_OUTPUT_DIR (${dir})`);
  });

  it("refuses before anything is fetched when the folder is unset or missing", async () => {
    const unset = localFileAccess({ fileDirs: [], outputDir: undefined });
    expect((await refusal(unset.checkDelivery())).message).toContain(
      "SEVDESK_OUTPUT_DIR is not set",
    );
    expect(
      (await refusal(unset.deliver({ filename: "a.csv", kind: "csv", bytes: PDF }))).message,
    ).toContain("SEVDESK_OUTPUT_DIR is not set");
    expect(unset.describeDelivery()).toBe("nowhere: SEVDESK_OUTPUT_DIR is not set");

    const missing = join(await tempDir(), "missing");
    const files = localFileAccess({ fileDirs: [], outputDir: missing });
    expect((await refusal(files.checkDelivery())).message).toBe(
      `SEVDESK_OUTPUT_DIR (${missing}) does not exist; the user has to create it.`,
    );
  });

  it("turns a failed write into a trusted refusal that names only the error code", async () => {
    const dir = await tempDir();
    const files = localFileAccess({ fileDirs: [], outputDir: dir });

    const error = await refusal(
      files.deliver({ filename: `${"x".repeat(300)}.pdf`, kind: "pdf", bytes: PDF }),
    );

    expect(error.message).toBe("The file could not be saved in SEVDESK_OUTPUT_DIR (ENAMETOOLONG).");
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("remoteFileAccess: uploads", () => {
  it("needs an HTTP deployment with file transfer", async () => {
    const { store } = await openTransfer();
    expect(() => remoteFileAccess(testConfig(), store, OWNER)).toThrow(/file transfer/);
    expect(() =>
      remoteFileAccess(testConfig({ deployment: filesOffDeployment() }), store, OWNER),
    ).toThrow(/file transfer/);
  });

  it("opens a ticket for the principal and reads its upload once uploaded", async () => {
    const transfer = await openTransfer();
    const files = transfer.access();

    expect(files.canRead).toBe(true);
    expect(files.canDeliver).toBe(true);
    const request = files.requestUpload("einvoice");
    const id = request.uploadId.slice("upload:".length);
    expect(request).toEqual({
      uploadId: expect.stringMatching(/^upload:[A-Za-z0-9_-]{43}$/) as unknown,
      url: `${FILES_ORIGIN}/uploads/${id}`,
      reference: expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/) as unknown,
      expiresAt: "2026-11-09T12:15:00.000Z",
      accepts: ["xml", "pdf"],
      maxBytes: 20 * 1024 * 1024,
    });

    // Not uploaded yet: refused without echoing the id.
    const pending = await refusal(files.read(request.uploadId, EINVOICE));
    expect(pending.message).toContain("has not finished the upload yet");
    expect(pending.message).not.toContain(id);

    await transfer.store.receive(id, OWNER.accountScope, {
      name: "RE-4711.xml",
      kind: "xml",
      bytes: XML,
    });
    expect(await files.read(request.uploadId, EINVOICE)).toEqual({
      name: "RE-4711.xml",
      kind: "xml",
      bytes: Buffer.from(XML),
      source: "upload",
    });
    // Reading does not consume the upload: a retry gets it again.
    expect((await files.read(request.uploadId, EINVOICE)).source).toBe("upload");
  });

  it("refuses another grant's or another account's upload exactly like an unknown one", async () => {
    const transfer = await openTransfer();
    const ref = await transfer.upload(PDF);
    const sameAccount: RequestPrincipal = { grantKey: "grant-2", accountScope: "4711" };
    const otherAccount: RequestPrincipal = { grantKey: "grant-1", accountScope: "4712" };
    const unknown = `upload:${"b".repeat(43)}`;

    const messages = await Promise.all([
      refusal(transfer.access(filesConfig(), sameAccount).read(ref, RECEIPT)),
      refusal(transfer.access(filesConfig(), otherAccount).read(ref, RECEIPT)),
      refusal(transfer.access().read(unknown, RECEIPT)),
    ]);
    expect(new Set(messages.map((error) => error.message)).size).toBe(1);
    expect(await transfer.access().read(ref, RECEIPT)).toMatchObject({ source: "upload" });
  });

  it("refuses an upload that expired", async () => {
    const transfer = await openTransfer();
    const ref = await transfer.upload(PDF);
    transfer.clock.advance(31 * 60_000);

    const error = await refusal(transfer.access().read(ref, RECEIPT));
    expect(error.message).toContain("expired");
  });

  it("checks the caller's kinds and size limit on the uploaded file", async () => {
    const transfer = await openTransfer();
    const png = await transfer.upload(PNG, { name: "scan.png", kind: "png" });

    const wrongKind = await refusal(transfer.access().read(png, EINVOICE));
    expect(wrongKind.message).toBe(
      'The uploaded file "scan.png" is a PNG file; accepted here: PDF, XML (checked by content). ' +
        "Ask the user to upload the right file through a new sevdesk_upload_request. Nothing " +
        "was sent to sevDesk.",
    );

    const tooLarge = await refusal(transfer.access().read(png, { maxBytes: 4, kinds: ["png"] }));
    expect(tooLarge.message).toContain(`has ${String(PNG.byteLength)} bytes; the limit here is 4`);
  });

  it("refuses a malformed upload reference and plain paths without local folders", async () => {
    const files = (await openTransfer()).access();

    const malformed = await refusal(files.read("upload:../../etc/passwd", RECEIPT));
    expect(malformed.message).toContain("not an uploadId as sevdesk_upload_request returns it");
    expect(malformed.message).not.toContain("passwd");

    const path = await refusal(files.read("/srv/belege/Beleg.pdf", RECEIPT));
    expect(path.message).toContain("reads no local paths");
    expect(path.message).toContain("sevdesk_upload_request");
    expect(path.message).not.toContain("/srv/belege");
  });

  it("still reads plain paths from SEVDESK_FILE_DIRS where configured (bearer mode)", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "Beleg.pdf"), PDF);
    const transfer = await openTransfer();
    const files = transfer.access(
      filesConfig({ deployment: filesDeployment("bearer"), fileDirs: [dir] }),
    );

    expect(await files.read("Beleg.pdf", RECEIPT)).toMatchObject({ source: "local" });
    const ref = await transfer.upload(PDF);
    expect(await files.read(ref, RECEIPT)).toMatchObject({ source: "upload" });
  });

  it("turns the store's limits into trusted refusals", async () => {
    const transfer = await openTransfer();
    const files = transfer.access();
    for (let index = 0; index < 5; index += 1) files.requestUpload("receipt");

    const error = await refusal(() => files.requestUpload("receipt"));
    expect(error.message).toContain("are still waiting for a file");
  });
});

describe("remoteFileAccess: deliveries", () => {
  it("hands files out as download links of the principal's account", async () => {
    const transfer = await openTransfer();
    const files = transfer.access();

    await files.checkDelivery();
    const delivery = await files.deliver({ filename: "RE-1001.pdf", kind: "pdf", bytes: PDF });

    expect(delivery).toEqual({
      download: {
        url: expect.stringMatching(
          new RegExp(`^${FILES_ORIGIN}/files/[A-Za-z0-9_-]{43}$`),
        ) as unknown,
        reference: expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/) as unknown,
        expiresAt: "2026-11-09T12:30:00.000Z",
      },
    });
    const id = ("download" in delivery ? delivery.download.url : "").split("/").pop() ?? "";
    expect(await transfer.store.takeDownload(id, "4712")).toEqual({ status: "unknown" });
    expect(await transfer.store.takeDownload(id, "4711")).toMatchObject({
      status: "served",
      file: { filename: "RE-1001.pdf", kind: "pdf", bytes: Buffer.from(PDF) },
    });
    expect(files.describeDelivery()).toBe(
      "a download link for the user (opened in the browser, signed in to this sevDesk account; " +
        "valid 30 minutes)",
    );
  });

  it("saves into SEVDESK_OUTPUT_DIR instead when that is set (bearer mode)", async () => {
    const dir = await tempDir();
    const transfer = await openTransfer();
    const files = transfer.access(
      filesConfig({ deployment: filesDeployment("bearer"), outputDir: dir }),
    );

    expect(files.describeDelivery()).toBe(`a new file in SEVDESK_OUTPUT_DIR (${dir})`);
    const delivery = await files.deliver({ filename: "export.csv", kind: "csv", bytes: PDF });
    expect(delivery).toEqual({ savedTo: join(await realpath(dir), "export.csv") });
    expect(transfer.store.usage().records).toBe(0);

    await rm(dir, { recursive: true });
    expect((await refusal(files.checkDelivery())).message).toContain("does not exist");
  });

  it("refuses a file larger than the store holds for one account, as a trusted refusal", async () => {
    const store = createTransferStore({
      blobs: await openBlobStore(),
      maxBytes: 64,
      fileTtlMs: 60_000,
      pruneIntervalMs: 0,
    });
    try {
      const files: FileAccess = remoteFileAccess(filesConfig(), store, OWNER);
      const error = await refusal(
        files.deliver({ filename: "big.zip", kind: "zip", bytes: new Uint8Array(40) }),
      );
      expect(error.message).toContain("SEVDESK_HTTP_FILES_MAX_MB");
      expect(error.cause).toBeDefined();
    } finally {
      await store.close();
    }
  });
});
