import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { bankAccountCreateTool as tool } from "../../../../src/tools/banking/account-create.js";
import { describeSevdeskError } from "../../../../src/tools/tool-errors.js";
import { ACCOUNT_CHECK_ACCOUNTS } from "../../../../src/tools/types.js";
import { testConfig } from "../../../helpers/config.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";

const ACCOUNTS: FakeRoute = {
  path: "/CheckAccount",
  response: { fixture: "banking/check-accounts.json" },
};

const CLEARING_CREATED: FakeRoute = {
  method: "POST",
  path: "/CheckAccount/Factory/clearingAccount",
  response: { fixture: "banking/clearing-account-create-4101.json" },
};

describe("sevdesk_bank_account_create", () => {
  it("is a write tool in the banking toolset with create annotations and an account lock", () => {
    expect(tool.tier).toBe("write");
    expect(tool.toolset).toBe("banking");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tool.locks?.(tool.input.parse({ kind: "clearing", name: "X" }))).toEqual([
      ACCOUNT_CHECK_ACCOUNTS,
    ]);
  });

  it("says that a cash register is made in the web app and accounts are only archived", () => {
    expect(tool.description).toMatch(/cash register \(Kasse\)\s+cannot be created through the API/);
    expect(tool.description).toMatch(/set it up in the sevDesk web app/);
    expect(tool.description).toMatch(/cannot be deleted through the API, only archived/);
  });

  it("creates a file-import account with the write tier and returns sevDesk's answer", async () => {
    const client = new FakeSevdeskClient([
      ACCOUNTS,
      {
        method: "POST",
        path: "/CheckAccount/Factory/fileImportAccount",
        response: { fixture: "banking/file-import-account-create-4102.json" },
      },
    ]);
    const { output } = await executeWrite(
      tool,
      { kind: "file_import", name: " Kasse Import ", accountingNumber: 1806 },
      client,
    );
    expect(client.writes().map((call) => [call.method, call.path, call.tier, call.body])).toEqual([
      [
        "POST",
        "/CheckAccount/Factory/fileImportAccount",
        "write",
        { name: "Kasse Import", importType: "CSV", accountingNumber: 1806 },
      ],
    ]);
    expect(output.summary).toBe("Created file-import account 4102 (booking account 1806).");
    expect(output.data.account).toMatchObject({
      id: 4102,
      type: "bank",
      fileImport: true,
      importType: "CSV",
    });
    expect(output.affected).toEqual([{ objectName: "CheckAccount", id: "4102" }]);
  });

  it("creates a clearing account and adds the differences from the request to the summary", async () => {
    const plain = await executeWrite(
      tool,
      { kind: "clearing", name: "Verrechnung" },
      new FakeSevdeskClient([ACCOUNTS, CLEARING_CREATED]),
    );
    expect(plain.output.summary).toBe("Created clearing account 4101 (booking account 1803).");

    const asked = await executeWrite(
      tool,
      { kind: "clearing", name: "Verrechnung", accountingNumber: 3320 },
      new FakeSevdeskClient([ACCOUNTS, CLEARING_CREATED]),
    );
    expect(asked.output.summary).toBe(
      "Created clearing account 4101 (booking account 1803). Note: sevDesk stored booking " +
        "account 1803, not the requested 3320.",
    );
  });

  it("shows the model its own explanation of sevDesk's refusal of a booking account (D-119)", async () => {
    // An archived account keeps its number and is not listed, so the pre-check passes 1803.
    const refusal = new SevdeskError({
      kind: "validation",
      status: 422,
      message: "sevDesk rejected the request as invalid.",
      upstreamMessage: "The given account number is already used",
    });
    const client = new FakeSevdeskClient([
      ACCOUNTS,
      { ...CLEARING_CREATED, response: { error: refusal } },
    ]);
    const error = await executeWrite(
      tool,
      { kind: "clearing", name: "Verrechnung", accountingNumber: 1803 },
      client,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SevdeskError);
    const text = describeSevdeskError(error as SevdeskError, {
      toolName: tool.name,
      tier: tool.tier,
      config: testConfig(),
    });
    expect(text).toBe(
      "sevDesk refused the request (HTTP 422): sevDesk refused booking account 1803: another " +
        "payment account already uses it, possibly an archived one, which keeps its number and is " +
        "not listed. Nothing was created. Choose another number, or leave accountingNumber out to " +
        "get the next free number of the 18xx range.",
    );
    expect(text).not.toContain("already used");
  });

  it("previews without writing and refuses a same-named active account before sending", async () => {
    const client = new FakeSevdeskClient([ACCOUNTS]);
    const plan = await prepareWrite(tool, { kind: "file_import", name: "Kasse 2" }, client);
    expect(plan.preview.action).toBe(
      'Create the file-import account (Dateiimport-Konto) "Kasse 2".',
    );
    await expect(
      prepareWrite(tool, { kind: "file_import", name: "kasse" }, client),
    ).rejects.toMatchObject({ kind: "validation", message: /account 4003 \(a cash register\)/ });
    expect(client.writes()).toEqual([]);
  });

  it("validates the arguments before anything is sent", () => {
    const parse = (args: Record<string, unknown>) => tool.input.safeParse(args).success;
    expect(parse({ kind: "clearing", name: "A" })).toBe(true);
    expect(parse({ name: "A" })).toBe(false);
    expect(parse({ kind: "cash", name: "Kasse" })).toBe(false);
    expect(parse({ kind: "clearing", name: "   " })).toBe(false);
    expect(parse({ kind: "clearing", name: "x".repeat(101) })).toBe(false);
    expect(parse({ kind: "clearing", name: "A", accountingNumber: 0 })).toBe(false);
    expect(parse({ kind: "clearing", name: "A", accountingNumber: 1800.5 })).toBe(false);
    expect(parse({ kind: "clearing", name: "A", accountingNumber: "1800" })).toBe(false);
    expect(parse({ kind: "clearing", name: "A", importType: "MT940" })).toBe(false);
    expect(parse({ kind: "file_import", name: "A", iban: "DE02100500000054540402" })).toBe(false);
  });
});
