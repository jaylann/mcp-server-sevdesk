/**
 * B5: a receipt file attaches to a voucher only through a top-level `filename`.
 *
 * `POST /Voucher/Factory/saveVoucher` takes the temp-file token from `uploadTempFile` as
 * `filename` next to `voucher`, and the spec says "the order of the last two attributes always
 * needs to be kept" (`voucherPosDelete`, then `filename`). Inside `voucher` sevDesk drops it
 * silently and the voucher is saved without document (spec/deviations.md D-026; confirmed by the
 * M4 probe on 2026-11-08, which also saw a top-level `filename` work in either key order).
 * joosthel/sevdesk-mcp#2 shipped it inside `voucher` first.
 *
 * Guard: the strict body schema has `filename` only at the top level, in the spec's key order,
 * and the upload is a multipart request with one part `file` (D-011). Tested through the real
 * HTTP client, so the JSON and the form on the wire are what is checked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { voucherCreateDraftTool } from "../../src/tools/vouchers/draft-create.js";
import { executeWrite } from "../helpers/write-tools.js";
import { PDF_BYTES, receiptFolder } from "../unit/tools/vouchers/routes.js";
import { fixtureReply } from "../unit/tools/vouchers/wire.js";
import {
  CREATE_ARGS,
  createReads,
  readBackReplies,
  wireClient,
} from "../unit/tools/vouchers/wire.js";

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-08T12:00:00+01:00") });
});

afterEach(async () => {
  vi.useRealTimers();
  await cleanup?.();
  cleanup = undefined;
});

describe("B5: the receipt token goes into a top-level filename, last", () => {
  it("uploads the file as multipart, then saves with filename after voucherPosDelete", async () => {
    const folder = await receiptFolder();
    cleanup = folder.undo;
    const { client, fake } = wireClient([
      ...createReads(),
      fixtureReply("vouchers/upload-temp-file.json"),
      fixtureReply("vouchers/save-voucher-response.json"),
      ...readBackReplies(),
    ]);

    const { output } = await executeWrite(
      voucherCreateDraftTool,
      { ...CREATE_ARGS, file: "Rechnung-0815.pdf" },
      client,
      { fileDirs: [folder.dir] },
    );

    const writes = fake.requests.filter((request) => request.method !== "GET");
    expect(writes.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "POST /api/v1/Voucher/Factory/uploadTempFile",
      "POST /api/v1/Voucher/Factory/saveVoucher",
    ]);

    const [upload, save] = writes;
    expect(upload?.body).toBeInstanceOf(FormData);
    const part = (upload?.body as FormData).get("file") as File;
    expect(part.name).toBe("Rechnung-0815.pdf");
    expect(part.type).toBe("application/pdf");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(PDF_BYTES);
    // fetch sets the multipart boundary itself; a hand-set content type would break it.
    expect(upload?.headers.get("content-type")).toBeNull();

    const wire = String(save?.body);
    const body = JSON.parse(wire) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      "voucher",
      "voucherPosSave",
      "voucherPosDelete",
      "filename",
    ]);
    expect(body["filename"]).toBe("f019bec36c65f5a0e7d2c63cc33f0681.pdf");
    expect(body["voucher"]).not.toHaveProperty("filename");
    expect(wire.indexOf('"voucherPosDelete"')).toBeLessThan(wire.indexOf('"filename"'));
    expect(wire.indexOf('"filename"')).toBe(wire.lastIndexOf('"filename"'));
    // The read-back shows the document (as the probe saw), so no note about a missing file.
    expect(output.data.voucher.hasDocument).toBe(true);
    expect(output.data.notes).toBeUndefined();
  });

  it("sends no filename at all without a file", async () => {
    const { client, fake } = wireClient([
      ...createReads(),
      fixtureReply("vouchers/save-voucher-response.json"),
      ...readBackReplies(),
    ]);
    await executeWrite(voucherCreateDraftTool, CREATE_ARGS, client);
    const save = fake.requests.find((request) => request.method === "POST");
    expect(Object.keys(JSON.parse(String(save?.body)) as object)).toEqual([
      "voucher",
      "voucherPosSave",
      "voucherPosDelete",
    ]);
  });
});
