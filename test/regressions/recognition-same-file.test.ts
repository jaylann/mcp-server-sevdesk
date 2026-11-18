/**
 * Regression (#127, spec/deviations.md D-100, D-103): sevDesk's receipt recognition
 * (`createVoucherFromFile`) does not deduplicate, so the same file sent twice makes a second
 * draft. `sevdesk_voucher_recognize_receipt` therefore compares the file's SHA-256 with the
 * `contentHash` of the receipts in sevDesk before the upload, and refuses a match before anything
 * is sent unless `allowDuplicate`. The check has a recorded limit that must stay visible: a
 * receipt made by the recognition itself carries `contentHash` null, so the same file recognised
 * before is not found, and the check must not pretend otherwise (no refusal, the receipt counted
 * as not compared).
 */
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../src/sevdesk/errors.js";
import { voucherRecognizeReceiptTool } from "../../src/tools/vouchers/recognize-receipt.js";
import { FakeSevdeskClient } from "../helpers/fake-client.js";
import { executeWrite } from "../helpers/write-tools.js";
import {
  PDF_BYTES,
  positionsRoute,
  receiptFolder,
  recognisedPositionRow,
  recognisedRow,
  recognitionRoute,
  type Row,
  sameFileRoute,
  storedReceiptRow,
  version2Route,
  voucherListRoute,
  voucherRoute,
} from "../unit/tools/vouchers/routes.js";

const DIGEST = createHash("sha256").update(PDF_BYTES).digest("hex");
const tool = voucherRecognizeReceiptTool({ sleep: () => Promise.resolve() });

let undo: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
});
afterEach(async () => {
  vi.useRealTimers();
  await undo?.();
  undo = undefined;
});

function client(stored: readonly Row[]): FakeSevdeskClient {
  return new FakeSevdeskClient([
    version2Route,
    sameFileRoute(stored),
    recognitionRoute(),
    voucherRoute(recognisedRow()),
    positionsRoute(2301, [recognisedPositionRow()]),
    voucherListRoute([]),
  ]);
}

async function run(stored: readonly Row[], allowDuplicate?: boolean) {
  const folder = await receiptFolder();
  undo = folder.undo;
  const fake = client(stored);
  const args =
    allowDuplicate === undefined ? { file: folder.file } : { file: folder.file, allowDuplicate };
  const outcome = await executeWrite(tool, args, fake, { fileDirs: [folder.dir] }).then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }),
  );
  return { fake, ...outcome };
}

describe("the same receipt file sent to sevDesk's recognition twice", () => {
  it("is refused before the upload when a stored receipt has its SHA-256", async () => {
    const { fake, error } = await run([storedReceiptRow(DIGEST.toUpperCase())]);
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("validation");
    expect((error as SevdeskError).message).toContain("already attached to voucher 2101");
    expect((error as SevdeskError).message).toContain("allowDuplicate: true");
    expect(fake.writes()).toEqual([]);
  });

  it("is sent with allowDuplicate, which is no more than a waste guard", async () => {
    const { fake, result } = await run([storedReceiptRow(DIGEST)], true);
    expect(fake.writes().map((write) => write.path)).toEqual([
      "/Voucher/Factory/createVoucherFromFile",
    ]);
    expect(result?.output.data.sameFileCheck.vouchers?.map((voucher) => voucher.id)).toEqual([
      2101,
    ]);
  });

  it("is not found when the earlier copy came from the recognition (contentHash null)", async () => {
    // Recorded 2026-11-17: a receipt made by createVoucherFromFile has contentHash null.
    const { fake, result, error } = await run([storedReceiptRow(null, { id: "2300" })]);
    expect(error).toBeUndefined();
    expect(fake.writes()).toHaveLength(1);
    const check = result?.output.data.sameFileCheck;
    expect(check?.vouchers).toBeUndefined();
    expect(check?.withoutChecksum).toBe(1);
    expect(result?.output.data.notes?.join(" ")).toContain(
      "a file recognised before is not found by the checksum check",
    );
  });
});
