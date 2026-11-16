import { describe, expect, it } from "vitest";

import {
  executeBankAccountCreate,
  planBankAccountCreate,
} from "../../../src/domain/bank-account-create.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { type FakeRoute, FakeSevdeskClient } from "../../helpers/fake-client.js";

/** Community account list: 4001 offline "Basiskonto" (1820), 4002 online bank "1800", … */
const ACCOUNTS: FakeRoute = {
  path: "/CheckAccount",
  response: { fixture: "banking/check-accounts.json" },
};

const CLEARING = "/CheckAccount/Factory/clearingAccount";
const FILE_IMPORT = "/CheckAccount/Factory/fileImportAccount";

function accountsWith(rows: readonly Record<string, unknown>[], total?: string): FakeRoute {
  return {
    path: "/CheckAccount",
    response: { body: total === undefined ? { objects: rows } : { total, objects: rows } },
  };
}

function created(path: string, response: FakeRoute["response"]): FakeRoute {
  return { method: "POST", path, response };
}

describe("planBankAccountCreate", () => {
  it("previews a clearing account and sends only its name to the clearing factory", async () => {
    const client = new FakeSevdeskClient([ACCOUNTS]);
    const plan = await planBankAccountCreate(client, {
      kind: "clearing",
      name: "Verrechnung Zahlungsanbieter",
    });
    expect(client.calls.map((call) => [call.method, call.path, call.query["limit"]])).toEqual([
      ["GET", "/CheckAccount", 1000],
    ]);
    expect(plan.state).toEqual({
      kind: "clearing",
      path: CLEARING,
      payload: { name: "Verrechnung Zahlungsanbieter" },
    });
    expect(plan.preview.action).toBe(
      'Create the clearing account (Verrechnungskonto) "Verrechnung Zahlungsanbieter".',
    );
    expect(plan.preview.facts).toEqual([
      { label: "Kind", value: "clearing account (Verrechnungskonto)" },
      { label: "Name", value: "Verrechnung Zahlungsanbieter" },
      { label: "Booking account (Buchungskonto)", value: "chosen by sevDesk" },
    ]);
    expect(plan.preview.warnings).toEqual([
      expect.stringMatching(/cannot delete a payment account through its API, only archive it/),
      expect.stringMatching(/clearing account takes no transactions entered by hand/),
      expect.stringMatching(/^Without accountingNumber sevDesk chooses the booking account/),
    ]);
    expect(plan.preview.irreversible).toBe(false);
  });

  it("sends a file-import account as CSV, with a booking account number when given", async () => {
    const plan = await planBankAccountCreate(new FakeSevdeskClient([ACCOUNTS]), {
      kind: "file_import",
      name: "Kasse Import",
      accountingNumber: 1806,
    });
    expect(plan.state).toEqual({
      kind: "file_import",
      path: FILE_IMPORT,
      payload: { name: "Kasse Import", importType: "CSV", accountingNumber: 1806 },
    });
    expect(plan.preview.facts).toContainEqual({
      label: "Booking account (Buchungskonto)",
      value: "1806",
    });
    expect(plan.preview.facts).toContainEqual({ label: "Import type", value: "CSV" });
    expect(plan.preview.warnings).toEqual([
      expect.stringMatching(/only archive it/),
      expect.stringMatching(/documents accountingNumber but its handling has not been recorded/),
    ]);
  });

  it("refuses a name an active account has, ignoring case and extra spaces, without echoing it", async () => {
    const client = new FakeSevdeskClient([ACCOUNTS]);
    const attempt = planBankAccountCreate(client, { kind: "clearing", name: "  basisKONTO " });
    await expect(attempt).rejects.toMatchObject({
      kind: "validation",
      message:
        "An active payment account with this name exists already: account 4001 (a clearing " +
        "account). Use that account (sevdesk_bank_accounts_list shows it), or choose another " +
        "name: sevDesk cannot delete a payment account, only archive it.",
    });
    expect(client.writes()).toEqual([]);
  });

  it("compares names after Unicode normalization and collapses inner whitespace", async () => {
    const client = new FakeSevdeskClient([
      accountsWith([{ id: "8001", name: "Geschäfts  Konto", type: "offline", status: "100" }]),
    ]);
    await expect(
      planBankAccountCreate(client, { kind: "file_import", name: "geschäfts konto" }),
    ).rejects.toMatchObject({ kind: "validation", message: /account 8001 \(a clearing account\)/ });
  });

  it("names a same-named file-import account as such", async () => {
    const client = new FakeSevdeskClient([
      accountsWith([
        { id: "8002", name: "Import", type: "online", importType: "CSV", status: "100" },
      ]),
    ]);
    await expect(
      planBankAccountCreate(client, { kind: "file_import", name: "Import" }),
    ).rejects.toMatchObject({ message: /account 8002 \(a file-import account\)/ });
  });

  it("allows the name of an archived account", async () => {
    const plan = await planBankAccountCreate(new FakeSevdeskClient([ACCOUNTS]), {
      kind: "clearing",
      name: "Altes Konto",
    });
    expect(plan.state.payload).toEqual({ name: "Altes Konto" });
  });

  it("refuses a booking account number another account (archived ones too) already has", async () => {
    await expect(
      planBankAccountCreate(new FakeSevdeskClient([ACCOUNTS]), {
        kind: "clearing",
        name: "Neu",
        accountingNumber: 1820,
      }),
    ).rejects.toMatchObject({
      kind: "validation",
      message:
        "Booking account 1820 is already used by payment account 4001, and every payment " +
        "account needs a booking account of its own. Choose another number, or leave " +
        "accountingNumber out to let sevDesk choose one.",
    });
    const client = new FakeSevdeskClient([
      accountsWith([
        { id: "8003", name: "Alt", type: "offline", status: "0", accountingNumber: "3320" },
      ]),
    ]);
    await expect(
      planBankAccountCreate(client, { kind: "clearing", name: "Neu", accountingNumber: 3320 }),
    ).rejects.toMatchObject({ message: /payment account 8003/ });
  });

  it("warns when sevDesk has more accounts than one page shows", async () => {
    const client = new FakeSevdeskClient([
      accountsWith([{ id: "8004", name: "A", type: "offline", status: "100" }], "1200"),
    ]);
    const plan = await planBankAccountCreate(client, { kind: "clearing", name: "B" });
    expect(plan.preview.warnings.at(-1)).toMatch(/checked against the first 1000 only/);
  });

  it("works on an account without any payment account", async () => {
    const plan = await planBankAccountCreate(new FakeSevdeskClient([accountsWith([])]), {
      kind: "file_import",
      name: "Erstes Konto",
    });
    expect(plan.state.path).toBe(FILE_IMPORT);
  });
});

describe("executeBankAccountCreate", () => {
  const clearingState = {
    kind: "clearing",
    path: CLEARING,
    payload: { name: "Verrechnung Zahlungsanbieter" },
  } as const;
  const importState = {
    kind: "file_import",
    path: FILE_IMPORT,
    payload: { name: "Kasse Import", importType: "CSV", accountingNumber: 1806 },
  } as const;

  it("posts once and reads the account from sevDesk's answer", async () => {
    const client = new FakeSevdeskClient([
      created(CLEARING, { fixture: "banking/clearing-account-create-4101.json" }),
    ]);
    const result = await executeBankAccountCreate(client, clearingState);
    expect(client.calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["POST", CLEARING, { name: "Verrechnung Zahlungsanbieter" }],
    ]);
    expect(result).toEqual({
      account: {
        id: 4101,
        name: "Verrechnung Zahlungsanbieter",
        type: "clearing",
        sevdeskType: "offline",
        fileImport: false,
        currency: "EUR",
        status: { code: 100, label: "Active" },
        isDefault: false,
        accountingNumber: "1803",
      },
      notes: [],
    });
  });

  it("reads a file-import account as such, also from an array of one", async () => {
    const client = new FakeSevdeskClient([
      created(FILE_IMPORT, {
        body: {
          objects: [
            {
              id: "4102",
              name: "Kasse Import",
              type: "online",
              importType: "CSV",
              currency: "EUR",
              status: "100",
              accountingNumber: "1806",
            },
          ],
        },
      }),
    ]);
    const result = await executeBankAccountCreate(client, importState);
    expect(result.account).toMatchObject({
      id: 4102,
      type: "bank",
      fileImport: true,
      importType: "CSV",
      accountingNumber: "1806",
    });
    expect(result.notes).toEqual([]);
  });

  it("reports when the answer shows another kind or booking account than requested", async () => {
    const client = new FakeSevdeskClient([
      created(FILE_IMPORT, {
        body: {
          objects: { id: "4103", name: "Kasse Import", type: "online", accountingNumber: "1807" },
        },
      }),
    ]);
    const result = await executeBankAccountCreate(client, importState);
    expect(result.account.fileImport).toBe(false);
    expect(result.notes).toEqual([
      "sevDesk's answer does not show the account as a file-import account (Dateiimport-Konto) " +
        "(it reads as a bank account); check it with sevdesk_bank_accounts_list before using it.",
      "sevDesk stored booking account 1807, not the requested 1806.",
    ]);

    const odd = new FakeSevdeskClient([
      created(CLEARING, {
        body: { objects: { id: "4104", type: "online", accountingNumber: "`x`" } },
      }),
    ]);
    const oddResult = await executeBankAccountCreate(odd, {
      ...clearingState,
      payload: { name: "X", accountingNumber: 3320 },
    });
    expect(oddResult.notes).toEqual([
      expect.stringMatching(/does not show the account as a clearing account/),
      "sevDesk's answer does not show the requested booking account 3320.",
    ]);
  });

  it("says the account was probably created when the answer holds no readable account", async () => {
    for (const body of [{ objects: null }, { objects: { name: "ohne id" } }, { objects: [] }]) {
      const client = new FakeSevdeskClient([created(CLEARING, { body })]);
      await expect(executeBankAccountCreate(client, clearingState)).rejects.toMatchObject({
        kind: "unexpected_response",
        message: /accepted the new payment account.*Do not repeat the call/,
      });
      expect(client.writes()).toHaveLength(1);
    }
  });

  it("never retries a failed POST", async () => {
    const failure = new SevdeskError({ kind: "server", message: "sevDesk had an internal error." });
    const client = new FakeSevdeskClient([created(CLEARING, { error: failure })]);
    await expect(executeBankAccountCreate(client, clearingState)).rejects.toBe(failure);
    expect(client.writes()).toHaveLength(1);
  });
});
