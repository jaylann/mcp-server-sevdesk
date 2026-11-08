/**
 * Contract tests over the fixtures recorded on the trial account on 2026-11-08 (M4 recording
 * session, `pnpm fixtures:record`): every recorded file goes through the production reader that
 * handles it in the server, so a change in sevDesk's answers (or in our parsers) shows up here.
 * The 2026-11-07 session has its own file (`recorded-fixtures.test.ts`).
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  fetchAccountSettings,
  loadAccountCompany,
  taxRegimeOf,
} from "../../src/domain/account-settings.js";
import { getTransactionDetails, listTransactions } from "../../src/domain/banking.js";
import { readDatevExportConfig } from "../../src/domain/exports/datev.js";
import {
  parseLogEntry,
  readTransactionLog,
} from "../../src/domain/reconciliation/transaction-log.js";
import { listVoucherPositions, listVouchers } from "../../src/domain/vouchers.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../helpers/fake-client.js";

const SESSION = "2026-11-08";
const DIR = `recorded/${SESSION}`;

/** Every recorded file (path below the session folder) and the production reader it is checked with. */
const RECORDED: Readonly<Record<string, string>> = {
  "banking/transaction-by-id.json": "getTransactionDetails",
  "banking/transaction-log-unfiltered.json": "parseLogEntry (paymentsInPeriod's full-log scan)",
  "banking/transaction-log.json": "readTransactionLog",
  "banking/transactions-list.json": "listTransactions",
  "meta/sev-client.json": "fetchAccountSettings + loadAccountCompany + readDatevExportConfig",
  "vouchers/voucher-positions-embed-account.json": "listVoucherPositions",
  "vouchers/vouchers-list.json": "listVouchers",
};

function fixture(file: string): string {
  return `${DIR}/${file}`;
}

function route(path: string, file: string): FakeRoute {
  return { path, response: { fixture: fixture(file) } };
}

function rows(file: string): Record<string, unknown>[] {
  const body = loadFixture(fixture(file)).body as { objects: unknown };
  return body.objects as Record<string, unknown>[];
}

function refId(row: Record<string, unknown> | undefined, key: string): number {
  const ref = row?.[key] as { id?: unknown } | undefined;
  return Number(ref?.id);
}

const SESSION_DIR = fileURLToPath(new URL(`../fixtures/${DIR}/`, import.meta.url));

function filesBelow(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

const FILES_ON_DISK = filesBelow(SESSION_DIR)
  .map((path) => relative(SESSION_DIR, path).split("\\").join("/"))
  .sort();

describe(`recorded fixtures ${SESSION}: provenance and coverage`, () => {
  it("has a contract test for every recorded file, and a file for every contract", () => {
    expect(FILES_ON_DISK).toEqual(Object.keys(RECORDED).sort());
  });

  it.each(FILES_ON_DISK)("%s says it was recorded on the trial account", (file) => {
    const { _provenance: provenance, status } = loadFixture(fixture(file));
    expect(provenance.source).toBe("recorded");
    expect(provenance.date).toBe(SESSION);
    expect(provenance.systemVersion).toBe("2.0");
    expect(provenance.ref).toMatch(/^GET \//);
    expect(provenance.ref).toContain(`recording session ${SESSION}`);
    expect(status).toBe(200);
  });
});

describe(`recorded ${SESSION}: account settings`, () => {
  const client = () => new FakeSevdeskClient([route("/SevClient", "meta/sev-client.json")]);

  it("reads the regime, the chart of accounts and the company fields", async () => {
    const settings = await fetchAccountSettings(client());
    expect(taxRegimeOf(settings)).toBe("regular");
    const company = await loadAccountCompany(client(), { cacheOwner: {} });
    expect(company?.email).toBe("person1@example.com");
  });

  it("reads the DATEV export configuration the M4 probe set (D-067)", async () => {
    const config = await readDatevExportConfig(client());
    expect(config).toMatchObject({ accountantNumber: "1001", accountantClientNumber: "1" });
  });
});

describe(`recorded ${SESSION}: vouchers`, () => {
  it("lists the recorded vouchers", async () => {
    const client = new FakeSevdeskClient([route("/Voucher", "vouchers/vouchers-list.json")]);
    const result = await listVouchers(client, { limit: 25, offset: 0 });
    expect(result.items.length).toBe(rows("vouchers/vouchers-list.json").length);
  });

  it("reads Update 2.0 positions with their booking account (D-045)", async () => {
    const file = "vouchers/voucher-positions-embed-account.json";
    const voucherId = refId(rows(file)[0], "voucher");
    const client = new FakeSevdeskClient([route("/VoucherPos", file)]);
    const { positions, complete } = await listVoucherPositions(client, voucherId, "EUR");
    expect(complete).toBe(true);
    expect(positions).toHaveLength(rows(file).length);
    expect(positions[0]?.accountDatev).toBeDefined();
  });
});

describe(`recorded ${SESSION}: transactions and their log (D-057)`, () => {
  it("lists the recorded transactions", async () => {
    const client = new FakeSevdeskClient([
      route("/CheckAccountTransaction", "banking/transactions-list.json"),
      // The accounts (names, currencies) come from the 2026-11-07 recording of the same account.
      {
        path: "/CheckAccount",
        response: { fixture: "recorded/2026-11-07/banking/check-accounts.json" },
      },
    ]);
    const result = await listTransactions(client, { limit: 5, offset: 0 });
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("reads one transaction with its account", async () => {
    const row = rows("banking/transaction-by-id.json")[0];
    const id = Number(row?.["id"]);
    const accountId = refId(row, "checkAccount");
    const account = loadFixture("recorded/2026-11-07/banking/check-accounts.json").body as {
      objects: Record<string, unknown>[];
    };
    const accountRow = account.objects.find((candidate) => Number(candidate["id"]) === accountId);
    expect(accountRow, "the transaction's account is in the 2026-11-07 recording").toBeDefined();
    const client = new FakeSevdeskClient([
      route(`/CheckAccountTransaction/${String(id)}`, "banking/transaction-by-id.json"),
      { path: `/CheckAccount/${String(accountId)}`, response: { body: { objects: [accountRow] } } },
    ]);
    const details = await getTransactionDetails(client, id);
    expect(details.transaction.id).toBe(id);
  });

  it("reads the log of one transaction: signed amountPaid, object = the document", async () => {
    const file = "banking/transaction-log.json";
    const transactionId = refId(rows(file)[0], "checkAccountTransaction");
    const client = new FakeSevdeskClient([route("/CheckAccountTransactionLog", file)]);
    const log = await readTransactionLog(client, transactionId);
    expect(log.entries).toHaveLength(rows(file).length);
    for (const entry of log.entries) expect(entry.document).toBeDefined();
  });

  it("parses every entry of the unfiltered log", () => {
    for (const raw of rows("banking/transaction-log-unfiltered.json")) {
      const entry = parseLogEntry(raw);
      expect(Number.isSafeInteger(entry.transactionId)).toBe(true);
    }
  });
});
