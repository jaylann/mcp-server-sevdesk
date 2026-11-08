/**
 * B6: the receipt upload's preview never reaches the model.
 *
 * `POST /Voucher/Factory/uploadTempFile` answers the temp-file token together with a base64 JPEG
 * preview of the file in `objects.content` (about 100 KB even for a tiny PDF:
 * joosthel/sevdesk-mcp#2; 116 KB in the M4 probe, 2026-11-08; spec/deviations.md D-011). Passing
 * the answer on would flood the context and carry file content into the conversation.
 *
 * Guard: only `filename` and `pages` are read from the answer (`readUploadAnswer`); the tool output
 * names the local file, its kind, size and page count. Tested through the real HTTP client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { voucherCreateDraftTool } from "../../src/tools/vouchers/draft-create.js";
import { loadFixture } from "../helpers/fake-client.js";
import { executeWrite } from "../helpers/write-tools.js";
import { receiptFolder } from "../unit/tools/vouchers/routes.js";
import {
  CREATE_ARGS,
  createReads,
  fixtureReply,
  readBackReplies,
  wireClient,
} from "../unit/tools/vouchers/wire.js";

const PREVIEW_MARKER = "PREVIEW-BASE64-MUST-NOT-LEAK";

let cleanup: (() => Promise<void>) | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-08T12:00:00+01:00") });
});

afterEach(async () => {
  vi.useRealTimers();
  await cleanup?.();
  cleanup = undefined;
});

describe("B6: the upload preview is stripped", () => {
  it("keeps only the token, and the output only file name, kind, size and pages", async () => {
    expect(JSON.stringify(loadFixture("vouchers/upload-temp-file.json").body)).toContain(
      PREVIEW_MARKER,
    );
    const folder = await receiptFolder();
    cleanup = folder.undo;
    const { client } = wireClient([
      ...createReads(),
      fixtureReply("vouchers/upload-temp-file.json"),
      fixtureReply("vouchers/save-voucher-response.json"),
      ...readBackReplies(),
    ]);

    const { plan, output } = await executeWrite(
      voucherCreateDraftTool,
      { ...CREATE_ARGS, file: folder.file },
      client,
      { fileDirs: [folder.dir] },
    );

    const everything = JSON.stringify({ plan: plan.preview, output });
    expect(everything).not.toContain(PREVIEW_MARKER);
    expect(everything).not.toContain("contentHash");
    expect(everything).not.toContain("f019bec36c65f5a0e7d2c63cc33f0681");
    expect(output.data.receipt).toEqual({
      name: "Rechnung-0815.pdf",
      kind: "pdf",
      bytes: expect.any(Number) as number,
      pages: 1,
    });
    expect(everything.length).toBeLessThan(20_000);
  });
});
