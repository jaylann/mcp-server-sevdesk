/**
 * `sevdesk_receipt_folder_check` end to end on a real temporary folder and a fake client: offered
 * only with local folders, refuses before anything is read, reads only the voucher list.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ReceiptFolderResult } from "../../../../src/domain/reports/audit/receipt-folder.js";
import { MAX_DESCRIPTION_LENGTH } from "../../../../src/tools/define-tool.js";
import { JSON_SCHEMA_OPTIONS } from "../../../../src/tools/json-schema.js";
import { REPORT_TOOLS } from "../../../../src/tools/reports/index.js";
import { receiptFolderCheckTool } from "../../../../src/tools/reports/receipt-folder.js";
import { allEnabledConfig } from "../../../helpers/config.js";
import { type FakeRoute, loadFixture, testContext } from "../../../helpers/fake-client.js";
import { filesDeployment, filesOffDeployment } from "../../../helpers/transfer.js";
import { scenarioRoutes, voucherDoc } from "../../domain/reports/builders.js";
import { runTool } from "./records.js";

type Raw = Record<string, unknown>;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const BOOKED = encode("%PDF-1.7\nbooked receipt\n%%EOF\n");
const UNBOOKED = encode("%PDF-1.7\nnever booked\n%%EOF\n");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

let base: string;
let folder: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "sevdesk-receipt-folder-tool-")));
  folder = join(base, "Belege");
  await mkdir(join(folder, "2026-03"), { recursive: true });
  await writeFile(join(folder, "2026-03", "booked.pdf"), BOOKED);
  await writeFile(join(folder, "2026-03", "unbooked.pdf"), UNBOOKED);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const DOCUMENT = (() => {
  const body = loadFixture("recorded/2026-11-10/advanced/documents.json").body as {
    objects: Raw[];
  };
  const row = body.objects[0];
  if (row === undefined) throw new Error("document fixture is empty");
  return row;
})();

/** One booked voucher in March whose receipt is `booked.pdf`, as `embed=document` lists it. */
function routes(): FakeRoute[] {
  const row = voucherDoc(
    { id: 9101, date: "2026-03-12", net: "100", tax: "19", contactId: 3001 },
    {
      document: {
        ...structuredClone(DOCUMENT),
        id: "8101",
        object: null,
        baseObject: null,
        contentHash: sha(BOOKED),
      },
    },
  );
  return scenarioRoutes({ vouchers: [{ row, positions: [] }] });
}

const withFolder = (client: Parameters<typeof testContext>[0]) =>
  testContext(client, { SEVDESK_FILE_DIRS: folder });

describe("sevdesk_receipt_folder_check: metadata", () => {
  it("is a read tool of the reports toolset that reads local files and changes nothing", () => {
    expect(receiptFolderCheckTool).toMatchObject({
      name: "sevdesk_receipt_folder_check",
      toolset: "reports",
      tier: "read",
      localEffects: "reads-files",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(REPORT_TOOLS).toContain(receiptFolderCheckTool);
  });

  it("is offered only where local folders can be read, never for uploads alone", () => {
    const available = (overrides: Parameters<typeof allEnabledConfig>[0]): boolean | undefined =>
      receiptFolderCheckTool.available?.(allEnabledConfig(overrides));
    expect(available({})).toBe(false);
    expect(available({ outputDir: "/out" })).toBe(false);
    expect(available({ deployment: filesDeployment() })).toBe(false);
    expect(available({ deployment: filesOffDeployment() })).toBe(false);
    expect(available({ fileDirs: ["/in"] })).toBe(true);
    expect(available({ fileDirs: ["/in"], deployment: filesDeployment("bearer") })).toBe(true);
  });

  it("takes an optional folder, subfolders and the period", () => {
    expect(Object.keys(receiptFolderCheckTool.input.shape)).toEqual([
      "folder",
      "subfolders",
      "year",
      "month",
      "quarter",
      "from",
      "to",
    ]);
    const json = z.toJSONSchema(receiptFolderCheckTool.input, {
      ...JSON_SCHEMA_OPTIONS,
      io: "input",
    });
    expect(json.required).toBeUndefined();
    const { description } = receiptFolderCheckTool;
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(description).toContain("SEVDESK_FILE_DIRS");
    expect(description).toContain("No match is a hint, not proof");
  });
});

describe("sevdesk_receipt_folder_check", () => {
  it("finds the unbooked file and the booked one, reading only the voucher list", async () => {
    const { client, data, result } = await runTool(
      receiptFolderCheckTool,
      { folder: "2026-03", year: 2026, month: 3 },
      routes(),
      withFolder,
    );
    const report = data as ReceiptFolderResult;

    expect(report.coverage.folders).toEqual([join(folder, "2026-03")]);
    expect(report.matched).toEqual([
      {
        path: join(folder, "2026-03", "booked.pdf"),
        vouchers: [expect.objectContaining({ id: 9101 })],
      },
    ]);
    expect(report.findings.map((finding) => finding.code)).toEqual(["receipt_file_not_booked"]);
    expect(report.findings[0]?.files.map((file) => file.path)).toEqual([
      join(folder, "2026-03", "unbooked.pdf"),
    ]);
    expect(result.summary).toBe(
      "Receipt folder 2026-03: 2 files checked, 1 found on a voucher, 1 not found.",
    );
    expect(result.summary).not.toContain("unbooked");
    expect(client.writes()).toEqual([]);
    expect(client.calls.map((call) => [call.method, call.path, call.query["embed"]])).toEqual([
      ["GET", "/Voucher", "document"],
    ]);
  });

  it("says that subfolders were not read unless asked", async () => {
    const plain = await runTool(
      receiptFolderCheckTool,
      { year: 2026, month: 3 },
      routes(),
      withFolder,
    );
    const report = plain.data as ReceiptFolderResult;
    expect(report.coverage.filesChecked).toBe(0);
    expect(report.notes.join(" ")).toContain("pass subfolders: true");
    expect(plain.client.calls).toEqual([]);

    const deep = await runTool(
      receiptFolderCheckTool,
      { subfolders: true, year: 2026, month: 3 },
      routes(),
      withFolder,
    );
    expect((deep.data as ReceiptFolderResult).coverage.filesChecked).toBe(2);
  });

  it("refuses a folder outside SEVDESK_FILE_DIRS before sending anything", async () => {
    await expect(
      runTool(receiptFolderCheckTool, { folder: base, year: 2026, month: 3 }, routes(), withFolder),
    ).rejects.toMatchObject({ kind: "validation" });
    await expect(
      runTool(
        receiptFolderCheckTool,
        { folder: "../", year: 2026, month: 3 },
        routes(),
        withFolder,
      ),
    ).rejects.toMatchObject({ kind: "validation" });
  });

  it("refuses without SEVDESK_FILE_DIRS and with a malformed period", async () => {
    const unset = runTool(receiptFolderCheckTool, { year: 2026, month: 3 }, routes());
    await expect(unset).rejects.toMatchObject({ kind: "validation" });
    await expect(unset).rejects.toThrow("SEVDESK_FILE_DIRS is not set");
    await expect(
      runTool(receiptFolderCheckTool, { year: 2026, from: "2026-01-01" }, routes(), withFolder),
    ).rejects.toMatchObject({ kind: "validation" });
  });
});
