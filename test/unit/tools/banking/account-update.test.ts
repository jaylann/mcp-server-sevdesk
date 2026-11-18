import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { argumentsHash } from "../../../../src/safety/hashing.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { bankAccountUpdateTool as tool } from "../../../../src/tools/banking/account-update.js";
import { describeSevdeskError } from "../../../../src/tools/tool-errors.js";
import { ACCOUNT_BOOKINGS, ACCOUNT_CHECK_ACCOUNTS } from "../../../../src/tools/types.js";
import { testConfig } from "../../../helpers/config.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { closeWriteHarnessesAfterEach, writeHarness } from "../../../helpers/write-flow.js";
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

/** A valid IBAN (ISO 13616 check digits) and BIC, made up. */
const IBAN = "DE89370400440532013000";
const BIC = "COBADEFFXXX";

/** An active file-import account (type online, importType CSV, no bank server; D-097). */
const importAccount = accountRow(4004, {
  status: "100",
  name: "Import-Konto",
  accountingNumber: "1810",
  autoMapTransaction: "1",
});

function rowsOf(accountId: number, rows: readonly Row[]): FakeRoute {
  return listRoute("/CheckAccountTransaction", rows, { "checkAccount[id]": accountId });
}

/** The account before the PUT, then the PUT and the account as read back. */
function staged(before: Row, after: Row, extra: readonly FakeRoute[] = []): StagedClient {
  return new StagedClient(
    [accountRoute(before), accountsListRoute(), ...extra],
    [
      {
        method: "PUT",
        path: `/CheckAccount/${String(before["id"])}`,
        response: { body: { objects: after } },
      },
      accountRoute(after),
    ],
  );
}

describe("sevdesk_bank_account_update", () => {
  it("is a commit tool in the banking toolset; a new booking account also locks the bookings", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.toolset).toBe("banking");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    const account = { objectName: "CheckAccount", id: "4004" };
    expect(tool.locks?.(tool.input.parse({ id: 4004, name: "X" }))).toEqual([
      ACCOUNT_CHECK_ACCOUNTS,
      account,
    ]);
    expect(tool.locks?.(tool.input.parse({ id: 4004, accountingNumber: 1809 }))).toEqual([
      ACCOUNT_CHECK_ACCOUNTS,
      ACCOUNT_BOOKINGS,
      account,
    ]);
  });

  it("renames a file-import account, binding the preview to the stored account in both languages", async () => {
    const client = staged(importAccount, { ...importAccount, name: "Import Sparkasse" });
    const { plan, output } = await executeWrite(
      tool,
      { id: 4004, name: " Import Sparkasse " },
      client,
    );
    expect(client.writes().map((call) => [call.method, call.path, call.tier, call.body])).toEqual([
      ["PUT", "/CheckAccount/4004", "commit", { name: "Import Sparkasse" }],
    ]);
    expect(plan.preview).toEqual({
      action: "Change payment account 4004: name.",
      facts: [
        { label: "Payment account", value: "id 4004" },
        { label: "Kind", value: "file-import account (Dateiimport-Konto)" },
        { label: "Name", value: "Import-Konto → Import Sparkasse" },
        { label: "Booking account (Buchungskonto)", value: "1810" },
      ],
      warnings: [
        "Nothing else changes: the transactions and the balance (Saldo) stay as they are. Undo: " +
          "set the values left of the arrows again with sevdesk_bank_account_update.",
      ],
      irreversible: false,
    });
    expect(plan.previewDe.action).toBe("Zahlungskonto 4004 ändern: Name.");
    expect(plan.previewDe.facts.map((fact) => fact.label)).toEqual([
      "Zahlungskonto",
      "Art",
      "Name",
      "Buchungskonto",
    ]);
    expect(output.summary).toBe("Payment account 4004 changed; read back as sent.");
    expect(output.data.account).toMatchObject({
      id: 4004,
      name: "Import Sparkasse",
      fileImport: true,
    });
    expect(output.affected).toEqual([{ objectName: "CheckAccount", id: "4004" }]);
  });

  it("renames a clearing account and a cash register too", async () => {
    for (const id of [4001, 4003]) {
      const before = accountRow(id);
      const client = staged(before, { ...before, name: `Neu ${String(id)}` });
      await executeWrite(tool, { id, name: `Neu ${String(id)}` }, client);
      expect(client.writes().map((call) => call.body)).toEqual([{ name: `Neu ${String(id)}` }]);
    }
  });

  it("sends only the fields that change and refuses a call that changes nothing", async () => {
    const client = new FakeSevdeskClient([accountRoute(importAccount), accountsListRoute()]);
    const plan = await prepareWrite(
      tool,
      { id: 4004, name: "Import-Konto", iban: IBAN, autoMapTransactions: true },
      client,
    );
    expect(plan.state.payload).toEqual({ iban: IBAN });
    await expect(
      prepareWrite(tool, { id: 4004, name: "Import-Konto", autoMapTransactions: true }, client),
    ).rejects.toMatchObject({ kind: "validation", message: /already has the values given/ });
    await expect(prepareWrite(tool, { id: 4004 }, client)).rejects.toMatchObject({
      kind: "validation",
    });
    expect(client.writes()).toEqual([]);
  });

  it("refuses bank-connected and archived accounts before sending", async () => {
    const client = new FakeSevdeskClient([
      accountRoute(accountRow(4002)),
      accountRoute(accountRow(4004)),
      accountsListRoute(),
    ]);
    await expect(prepareWrite(tool, { id: 4002, name: "X" }, client)).rejects.toMatchObject({
      kind: "validation",
      message: /connected to a bank \(online banking\) or PayPal/,
    });
    // 4004 is archived (status 0) in the fixture.
    await expect(prepareWrite(tool, { id: 4004, name: "X" }, client)).rejects.toMatchObject({
      kind: "validation",
      message: /is archived/,
    });
    expect(client.writes()).toEqual([]);
  });

  it("refuses a name another active account has, ignoring case and spaces", async () => {
    const client = new FakeSevdeskClient([accountRoute(importAccount), accountsListRoute()]);
    await expect(prepareWrite(tool, { id: 4004, name: "  KASSE " }, client)).rejects.toMatchObject({
      kind: "validation",
      message: /account 4003/,
    });
    // A new spelling of the account's own name is a rename.
    const plan = await prepareWrite(tool, { id: 4004, name: "import-konto" }, client);
    expect(plan.state.payload).toEqual({ name: "import-konto" });
  });

  it("sets IBAN and BIC only on a file-import account and shows the IBAN masked", async () => {
    const client = new FakeSevdeskClient([
      accountRoute(importAccount),
      accountRoute(accountRow(4003)),
      accountsListRoute(),
    ]);
    const plan = await prepareWrite(
      tool,
      { id: 4004, iban: "de89 3704 0044 0532 0130 00", bic: "cobadeffxxx" },
      client,
    );
    expect(plan.state.payload).toEqual({ iban: IBAN, bic: BIC });
    expect(plan.preview.facts.slice(-2)).toEqual([
      { label: "IBAN", value: "****9999 → ****3000" },
      { label: "BIC", value: "none → COBADEFFXXX" },
    ]);
    // The previews (shown, logged, in dry runs) carry only the last four characters.
    expect(JSON.stringify([plan.preview, plan.previewDe])).not.toContain("DE893704");
    // Neither value can be set again from the preview: no undo is promised.
    expect(plan.preview.warnings).toEqual([
      "Nothing else changes: the transactions and the balance (Saldo) stay as they are.",
      "The previous IBAN is shown masked only, so it cannot be set again from this preview: " +
        "keep a note of it before approving if it may be needed again.",
      "Not set before: BIC. This tool cannot remove a value again.",
    ]);
    expect(plan.previewDe.warnings).toEqual([
      "Sonst ändert sich nichts: Umsätze und Saldo bleiben, wie sie sind.",
      "Die bisherige IBAN wird nur maskiert gezeigt und lässt sich aus dieser Vorschau nicht " +
        "wieder setzen: Notieren Sie sie vor der Freigabe, falls sie wieder gebraucht wird.",
      "Vorher nicht gesetzt: BIC. Dieses Tool kann einen Wert nicht wieder entfernen.",
    ]);
    await expect(prepareWrite(tool, { id: 4003, iban: IBAN }, client)).rejects.toMatchObject({
      kind: "validation",
      message: /cash register \(Kasse\): only its name is changed here/,
    });
    await expect(
      prepareWrite(tool, { id: 4003, accountingNumber: 1609 }, client),
    ).rejects.toMatchObject({ kind: "validation", message: /only its name is changed here/ });
    await expect(
      prepareWrite(tool, { id: 4003, autoMapTransactions: false }, client),
    ).rejects.toMatchObject({ kind: "validation", message: /only its name is changed here/ });
    expect(client.writes()).toEqual([]);
  });

  it("promises an undo only for the values the preview shows in full", async () => {
    const unknownAutoMap = { ...importAccount, autoMapTransaction: undefined };
    const client = new FakeSevdeskClient([accountRoute(unknownAutoMap), accountsListRoute()]);
    const plan = await prepareWrite(
      tool,
      { id: 4004, name: "Neu", iban: IBAN, autoMapTransactions: false },
      client,
    );
    expect(plan.preview.facts.at(-1)).toEqual({
      label: "Automatic assignment of imported transactions",
      value: "unknown → off",
    });
    expect(plan.preview.warnings).toEqual([
      "Nothing else changes: the transactions and the balance (Saldo) stay as they are. Undo " +
        "for Name: set the values left of the arrows again with sevdesk_bank_account_update.",
      "The previous IBAN is shown masked only, so it cannot be set again from this preview: " +
        "keep a note of it before approving if it may be needed again.",
      "sevDesk does not say whether automatic assignment was on before, so it cannot be set " +
        "back from this preview.",
    ]);
    expect(plan.previewDe.warnings[0]).toBe(
      "Sonst ändert sich nichts: Umsätze und Saldo bleiben, wie sie sind. Rückgängig für Name: " +
        "die Werte links der Pfeile mit sevdesk_bank_account_update wieder setzen.",
    );
    expect(plan.previewDe.warnings).toHaveLength(3);
  });

  it("checks IBAN check digits and the BIC form before anything is sent", () => {
    const parse = (args: Record<string, unknown>) => tool.input.safeParse(args).success;
    expect(parse({ id: 4004, iban: IBAN })).toBe(true);
    expect(parse({ id: 4004, iban: "DE89370400440532013001" })).toBe(false);
    expect(parse({ id: 4004, iban: "DE89" })).toBe(false);
    expect(parse({ id: 4004, bic: "COBADEFF" })).toBe(true);
    expect(parse({ id: 4004, bic: "COBA" })).toBe(false);
    expect(parse({ id: 4004, name: "   " })).toBe(false);
    expect(parse({ id: 4004, accountingNumber: "1809" })).toBe(false);
    expect(parse({ id: 4004, defaultAccount: true })).toBe(false);
    expect(parse({ id: 4004, status: 0 })).toBe(false);
    expect(parse({ id: 0, name: "A" })).toBe(false);
  });

  it("sends a free booking account as a string on an account without booked transactions", async () => {
    const open = transactionRow({ checkAccount: { id: "4004", objectName: "CheckAccount" } });
    const client = staged(importAccount, { ...importAccount, accountingNumber: "1809" }, [
      rowsOf(4004, [open]),
    ]);
    const { plan } = await executeWrite(tool, { id: 4004, accountingNumber: 1809 }, client);
    expect(client.writes().map((call) => call.body)).toEqual([{ accountingNumber: "1809" }]);
    expect(plan.preview.facts).toContainEqual({
      label: "Booking account (Buchungskonto)",
      value: "1810 → 1809",
    });
    expect(plan.preview.warnings[0]).toMatch(/Change it only on the tax consultant's advice/);
  });

  it("refuses a booking account in use, and one on an account with booked transactions", async () => {
    const booked = transactionRow({
      id: "5402",
      status: "400",
      checkAccount: { id: "4004", objectName: "CheckAccount" },
    });
    const client = new FakeSevdeskClient([
      accountRoute(importAccount),
      accountsListRoute(),
      rowsOf(4004, [booked]),
    ]);
    await expect(
      prepareWrite(tool, { id: 4004, accountingNumber: 1800 }, client),
    ).rejects.toMatchObject({ kind: "validation", message: /used by payment account 4002/ });
    await expect(
      prepareWrite(tool, { id: 4004, accountingNumber: 1809 }, client),
    ).rejects.toMatchObject({ kind: "validation", message: /booked transactions \(5402\)/ });
    expect(client.writes()).toEqual([]);
  });

  it("explains sevDesk's 400 for a booking account in use: nothing of the request was stored (D-144)", async () => {
    const refusal = new SevdeskError({
      kind: "validation",
      status: 400,
      message: "sevDesk rejected the request: validation error (HTTP 400).",
      upstreamMessage: "The given account number is already used",
    });
    const client = new FakeSevdeskClient([
      accountRoute(importAccount),
      accountsListRoute(),
      rowsOf(4004, []),
      { method: "PUT", path: "/CheckAccount/4004", response: { error: refusal } },
    ]);
    const error = await executeWrite(
      tool,
      { id: 4004, name: "Import Q2", accountingNumber: 1811 },
      client,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SevdeskError);
    expect(error).toMatchObject({ completedWrites: [] });
    expect(client.writes().map((call) => call.body)).toEqual([
      { name: "Import Q2", accountingNumber: "1811" },
    ]);
    const text = describeSevdeskError(error as SevdeskError, {
      toolName: tool.name,
      tier: tool.tier,
      config: testConfig(),
    });
    // Recorded: the name sent along was not stored either; an archived account never holds it.
    expect(text).toMatch(/sevDesk refused booking account 1811: another payment account/);
    expect(text).toContain("sevDesk refuses the whole request, so nothing was changed.");
    expect(text).not.toMatch(/archived|already used/);
  });

  it("takes the booking account number of an archived account (D-144)", async () => {
    // The listed account 4004 is archived with booking account 1810: sevDesk stores the number
    // for another account.
    const other = { ...importAccount, id: "4006", accountingNumber: "1812" };
    const client = staged(other, { ...other, accountingNumber: "1810" }, [rowsOf(4006, [])]);
    await executeWrite(tool, { id: 4006, accountingNumber: 1810 }, client);
    expect(client.writes().map((call) => [call.path, call.body])).toEqual([
      ["/CheckAccount/4006", { accountingNumber: "1810" }],
    ]);
  });

  it("sends automatic assignment under sevDesk's singular key, never the spec's plural (D-141)", async () => {
    const client = staged(importAccount, { ...importAccount, autoMapTransaction: "0" });
    const { plan } = await executeWrite(tool, { id: 4004, autoMapTransactions: false }, client);
    expect(client.writes().map((call) => call.body)).toEqual([{ autoMapTransaction: 0 }]);
    expect(plan.preview.facts.at(-1)).toEqual({
      label: "Automatic assignment of imported transactions",
      value: "on → off",
    });
    expect(plan.previewDe.facts.at(-1)).toEqual({
      label: "Automatische Zuordnung importierter Umsätze",
      value: "an → aus",
    });
  });

  it("fails when the read-back does not show a field as sent, though sevDesk answered 200 (D-141)", async () => {
    // sevDesk answers 200 for keys it ignores; the read-back shows the old values.
    const client = staged(importAccount, { ...importAccount, name: "Neu" });
    const error = await executeWrite(
      tool,
      { id: 4004, name: "Neu", autoMapTransactions: false },
      client,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      kind: "unexpected_response",
      message: /not as sent: Automatic assignment of imported transactions\. Other values/,
      completedWrites: [{ objectName: "CheckAccount", id: "4004" }],
    });
  });
});

describe("sevdesk_bank_account_update in the audit log", () => {
  closeWriteHarnessesAfterEach();
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function auditPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-account-update-audit-"));
    dirs.push(dir);
    return join(dir, "audit.jsonl");
  }

  const putRoute: FakeRoute = {
    method: "PUT",
    path: "/CheckAccount/4004",
    response: { body: { objects: importAccount } },
  };

  it("logs the IBAN masked, with the hash of the masked arguments, in every line", async () => {
    const path = await auditPath();
    const config = { auditLogPath: path };
    const call = { name: tool.name, arguments: { id: 4004, iban: "DE89 3704 0044 0532 0130 00" } };
    // A dry run; a change read back as sent (executed); one read back unchanged (failed).
    const dry = await writeHarness({
      tools: [tool],
      routes: [accountRoute(importAccount)],
      config,
    });
    await dry.client.callTool({ ...call, arguments: { ...call.arguments, dryRun: true } });
    const done = await writeHarness({
      tools: [tool],
      routes: [],
      config,
      wrap: () =>
        new StagedClient(
          [accountRoute(importAccount)],
          [putRoute, accountRoute({ ...importAccount, iban: IBAN })],
        ),
    });
    expect((await done.client.callTool(call)).isError).toBeFalsy();
    const failing = await writeHarness({
      tools: [tool],
      routes: [accountRoute(importAccount), putRoute],
      config,
    });
    expect((await failing.client.callTool(call)).isError).toBe(true);

    const text = await readFile(path, "utf8");
    expect(text).not.toContain(IBAN);
    expect(text).not.toContain("0532013000");
    const lines = text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line["event"])).toEqual([
      "dry_run",
      "confirmation_requested",
      "executing",
      "executed",
      "confirmation_requested",
      "executing",
      "failed",
    ]);
    const masked = { id: 4004, iban: "****3000" };
    const maskedHash = argumentsHash(tool.name, masked);
    expect(maskedHash).not.toBe(argumentsHash(tool.name, { id: 4004, iban: IBAN }));
    expect(lines[0]?.["args"]).toEqual({ ...masked, dryRun: true });
    for (const line of lines) {
      expect(line["args"]).toMatchObject(masked);
      expect(line["argsHash"]).toBe(maskedHash);
    }
  });
});
