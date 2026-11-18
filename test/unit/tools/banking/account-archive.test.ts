import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { bankAccountArchiveTool as tool } from "../../../../src/tools/banking/account-archive.js";
import { describeSevdeskError } from "../../../../src/tools/tool-errors.js";
import { ACCOUNT_BOOKINGS, ACCOUNT_CHECK_ACCOUNTS } from "../../../../src/tools/types.js";
import { testConfig } from "../../../helpers/config.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountRoute,
  accountRow,
  accountsListRoute,
  listRoute,
  type Row,
  StagedClient,
  transactionRow,
} from "../../domain/reconciliation/helpers.js";

/** An active file-import account with a stored IBAN (the fixture's ****9999). */
const importAccount = accountRow(4004, { status: "100", name: "Import-Konto" });
const onAccount = { checkAccount: { id: "4004", objectName: "CheckAccount" } };
const open = transactionRow({ id: "5401", valueDate: "2026-11-09T12:00:00+01:00", ...onAccount });

function rowsOf(rows: readonly Row[]): FakeRoute {
  return listRoute("/CheckAccountTransaction", rows, { "checkAccount[id]": 4004 });
}

const DELETE: FakeRoute = {
  method: "DELETE",
  path: "/CheckAccount/4004",
  response: { body: { objects: [null] } },
};

describe("sevdesk_bank_account_archive", () => {
  it("is an irreversible commit tool that locks the accounts and the bookings", async () => {
    expect(tool.tier).toBe("commit");
    expect(tool.toolset).toBe("banking");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool.locks?.(tool.input.parse({ id: 4004 }))).toEqual([
      ACCOUNT_CHECK_ACCOUNTS,
      ACCOUNT_BOOKINGS,
      { objectName: "CheckAccount", id: "4004" },
    ]);
    const plan = await prepareWrite(
      tool,
      { id: 4004 },
      new FakeSevdeskClient([accountRoute(importAccount), accountsListRoute(), rowsOf([])]),
    );
    expect(plan.preview.irreversible).toBe(true);
    expect(plan.previewDe.irreversible).toBe(true);
  });

  it("archives an account, names its open transactions and confirms status 0 on the read-back", async () => {
    const client = new StagedClient(
      [accountRoute(importAccount), accountsListRoute(), rowsOf([open])],
      [DELETE, accountRoute({ ...importAccount, status: "0", iban: null })],
    );
    const { plan, output } = await executeWrite(tool, { id: 4004 }, client);
    expect(client.writes().map((call) => [call.method, call.path, call.tier])).toEqual([
      ["DELETE", "/CheckAccount/4004", "commit"],
    ]);
    expect(plan.preview.action).toBe("Archive payment account 4004.");
    expect(plan.preview.facts).toEqual([
      { label: "Payment account", value: "id 4004" },
      { label: "Kind", value: "file-import account (Dateiimport-Konto)" },
      { label: "Name", value: "Import-Konto" },
      { label: "Booking account (Buchungskonto)", value: "1810" },
      { label: "IBAN", value: "****9999" },
      { label: "Open transactions deleted with it", value: "1" },
      { label: "Bank transaction 5401", value: "2026-11-09, 177.33 EUR, Musterfirma GmbH" },
    ]);
    expect(plan.preview.warnings).toEqual([
      expect.stringMatching(/cannot be restored\s+through the API/),
      expect.stringMatching(/deletes the account's 1 open \(unbooked\) transaction with it/),
      "sevDesk clears the account's stored IBAN when it archives it (the BIC stays).",
      expect.stringMatching(/^Checked: none of the account's transactions is booked/),
    ]);
    expect(plan.previewDe.action).toBe("Zahlungskonto 4004 archivieren.");
    expect(plan.previewDe.warnings[1]).toMatch(/löscht den offenen \(ungebuchten\) Umsatz/);
    expect(output.data.openTransactionsDeleted).toBe(1);
    expect(output.data.account.status).toEqual({ code: 0, label: "Archived" });
    expect(output.summary).toBe(
      "Payment account 4004 archived: it leaves the account lists and stays readable by id. 1 " +
        "open transaction was deleted with it.",
    );
  });

  it("archives a clearing account that is not the default", async () => {
    const clearing = accountRow(4001, { defaultAccount: "0", id: "4006" });
    const client = new StagedClient(
      [accountRoute(clearing), accountsListRoute(), listRoute("/CheckAccountTransaction", [])],
      [{ ...DELETE, path: "/CheckAccount/4006" }, accountRoute({ ...clearing, status: "0" })],
    );
    const { output } = await executeWrite(tool, { id: 4006 }, client);
    expect(output.data.openTransactionsDeleted).toBe(0);
    expect(output.summary).toBe(
      "Payment account 4006 archived: it leaves the account lists and stays readable by id.",
    );
  });

  it("refuses an account with booked transactions before sending", async () => {
    const booked = transactionRow({ id: "5402", status: "200", ...onAccount });
    const client = new FakeSevdeskClient([
      accountRoute(importAccount),
      accountsListRoute(),
      rowsOf([open, booked]),
    ]);
    await expect(prepareWrite(tool, { id: 4004 }, client)).rejects.toMatchObject({
      kind: "validation",
      message: /booked transactions \(5402\), and sevDesk does not archive/,
    });
    expect(client.writes()).toEqual([]);
  });

  it("refuses cash registers, the default account, bank-connected and archived accounts", async () => {
    const client = new FakeSevdeskClient([
      accountRoute(accountRow(4001)),
      accountRoute(accountRow(4002)),
      accountRoute(accountRow(4003)),
      accountRoute(accountRow(4004)),
    ]);
    const refusal = (id: number) => prepareWrite(tool, { id }, client);
    await expect(refusal(4001)).rejects.toMatchObject({ message: /default account/ });
    await expect(refusal(4002)).rejects.toMatchObject({ message: /connected to a bank/ });
    await expect(refusal(4003)).rejects.toMatchObject({ message: /cash register \(Kasse\)/ });
    await expect(refusal(4004)).rejects.toMatchObject({ message: /archived already/ });
    expect(client.writes()).toEqual([]);
  });

  it("explains sevDesk's refusal inside HTTP 200 for a booking made after the check (D-142)", async () => {
    const refusal = new SevdeskError({
      kind: "unexpected_response",
      status: 200,
      message:
        "sevDesk returned a response in an unexpected format (HTTP 200): it reports an error",
      upstreamMessage: "Cannot delete because of existing necessary references",
    });
    const client = new FakeSevdeskClient([
      accountRoute(importAccount),
      accountsListRoute(),
      rowsOf([]),
      { ...DELETE, response: { error: refusal } },
    ]);
    const error = await executeWrite(tool, { id: 4004 }, client).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "validation", completedWrites: [] });
    const text = describeSevdeskError(error as SevdeskError, {
      toolName: tool.name,
      tier: tool.tier,
      config: testConfig(),
    });
    expect(text).toMatch(/sevDesk refused to archive payment account 4004: transactions on it/);
    expect(text).toMatch(/Nothing was changed/);
    expect(text).not.toMatch(/necessary references/);
  });

  it("fails when the read-back still shows the account active", async () => {
    const client = new StagedClient(
      [accountRoute(importAccount), accountsListRoute(), rowsOf([])],
      [DELETE, accountRoute(importAccount)],
    );
    await expect(executeWrite(tool, { id: 4004 }, client)).rejects.toMatchObject({
      kind: "unexpected_response",
      message: /shows it still active/,
      completedWrites: [{ objectName: "CheckAccount", id: "4004" }],
    });
  });
});
