import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bookingTimestamp } from "../../../../src/domain/lifecycle/payments.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { transactionCreateTool as tool } from "../../../../src/tools/banking/transaction-create.js";
import { ACCOUNT_BOOKINGS } from "../../../../src/tools/types.js";
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountRoute,
  accountRow,
  accountsListRoute,
  invoiceRoute,
  invoiceRow,
  listRoute,
  logEntry,
  logRoute,
  type Row,
  StagedClient,
  transactionRoute,
  transactionRow,
  voucherRoute,
  voucherRow,
} from "../../domain/reconciliation/helpers.js";

/** An active file-import account (type online, importType CSV, no bank server; D-097). */
const IMPORT = accountRow(4004, { status: "100", name: "Import-Konto" });

/** The row sevDesk creates: an expense of 298.10 on the file-import account, at status 100. */
function created(overrides: Row = {}): Row {
  return transactionRow({
    id: "5401",
    amount: "-298.1",
    status: "100",
    valueDate: "2026-11-16T12:00:00+01:00",
    entryDate: "2026-11-16T12:00:00+01:00",
    payeePayerName: "Beispiel Lieferant AG",
    paymtPurpose: "RE-2026-0042",
    checkAccount: { id: "4004", objectName: "CheckAccount" },
    ...overrides,
  });
}

const ARGS = {
  checkAccountId: 4004,
  date: "2026-11-16",
  amount: "298.10",
  direction: "out",
  counterparty: "Beispiel Lieferant AG",
  purpose: "RE-2026-0042",
};

/** The account's rows of that day (the duplicate check). */
function dayRows(rows: readonly Row[] = []): FakeRoute {
  return listRoute("/CheckAccountTransaction", rows, { "checkAccount[id]": 4004 });
}

const POST: FakeRoute = {
  method: "POST",
  path: "/CheckAccountTransaction",
  response: { body: { objects: created() } },
};

function reads(extra: readonly FakeRoute[] = [], rows: readonly Row[] = []): FakeRoute[] {
  return [accountRoute(IMPORT), accountsListRoute(), dayRows(rows), ...extra];
}

describe("sevdesk_transaction_create", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-16T11:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a commit tool with commit annotations that locks the account's bookings", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(
      tool.locks?.(tool.input.parse({ ...ARGS, allocations: [{ kind: "voucher", id: 2001 }] })),
    ).toEqual([
      ACCOUNT_BOOKINGS,
      { objectName: "CheckAccount", id: "4004" },
      { objectName: "Voucher", id: "2001" },
    ]);
  });

  it("previews the new row in both languages and writes nothing in prepare", async () => {
    const client = new StagedClient(reads(), []);
    const plan = await prepareWrite(tool, ARGS, client);
    expect(plan.preview.action).toBe(
      "Enter a bank transaction of -298.10 EUR (outgoing) dated 2026-11-16 on file-import " +
        "account Import-Konto (id 4004).",
    );
    expect(plan.preview.facts).toEqual([
      { label: "Check account", value: "Import-Konto (id 4004, file-import account CSV)" },
      { label: "Value date", value: "2026-11-16" },
      { label: "Amount", value: "-298.10 EUR (outgoing)" },
      { label: "Counterparty", value: "Beispiel Lieferant AG" },
      { label: "Purpose (Verwendungszweck)", value: "RE-2026-0042" },
      { label: "Status afterwards", value: "unbooked (100)" },
    ]);
    expect(plan.preview.warnings).toEqual([
      expect.stringContaining("changes the balance of account 4004 by -298.10 EUR") as unknown,
    ]);
    expect(plan.preview.irreversible).toBe(false);
    expect(plan.previewDe.action).toBe(
      "Kontoumsatz über -298,10 EUR (Ausgang) vom 16.11.2026 auf dem Dateiimport-Konto " +
        "Import-Konto (ID 4004) anlegen.",
    );
    expect(plan.previewDe.facts.map((fact) => fact.label)).toEqual([
      "Zahlungskonto",
      "Wertstellung",
      "Betrag",
      "Auftraggeber/Empfänger",
      "Verwendungszweck",
      "Status danach",
    ]);
    expect(client.writes()).toEqual([]);
  });

  it("defaults the date to today and warns about a future date", async () => {
    const today = await prepareWrite(
      tool,
      { ...ARGS, date: undefined },
      new StagedClient(reads(), []),
    );
    expect(today.state.payload.valueDate).toBe("2026-11-16T11:00:00.000Z");
    const future = await prepareWrite(
      tool,
      { ...ARGS, date: "2026-11-20" },
      new StagedClient(reads(), []),
    );
    expect(future.preview.warnings).toContain("The value date 2026-11-20 lies in the future.");
    expect(future.previewDe.warnings).toContain(
      "Die Wertstellung 20.11.2026 liegt in der Zukunft.",
    );
  });

  it("names a row of that day with the same amount and purpose before a second one is made", async () => {
    const plan = await prepareWrite(tool, ARGS, new StagedClient(reads([], [created()]), []));
    expect(plan.preview.warnings).toContain(
      "Account 4004 already has a row on 2026-11-16 with the same amount and purpose (bank " +
        "transaction 5401). If this is the same payment, do not create it again.",
    );
  });

  it("creates the row once and reads it back", async () => {
    const client = new StagedClient(reads(), [
      POST,
      transactionRoute(created()),
      accountRoute(IMPORT),
    ]);
    const { output } = await executeWrite(tool, ARGS, client);
    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/CheckAccountTransaction",
        tier: "commit",
        body: {
          objectName: "CheckAccountTransaction",
          mapAll: true,
          valueDate: "2026-11-16T11:00:00.000Z",
          entryDate: "2026-11-16T11:00:00.000Z",
          amount: -298.1,
          paymtPurpose: "RE-2026-0042",
          payeePayerName: "Beispiel Lieferant AG",
          checkAccount: { id: 4004, objectName: "CheckAccount" },
          status: 100,
        },
      }),
    ]);
    expect(output.data.transaction).toMatchObject({
      id: 5401,
      amount: { amount: "-298.10", currency: "EUR" },
      direction: "out",
      status: { code: 100 },
    });
    expect(output.data.bookings).toEqual([]);
    expect(output.summary).toBe(
      "Bank transaction 5401 created: -298.10 EUR, status Created (100).",
    );
    expect(output.affected).toEqual([{ objectName: "CheckAccountTransaction", id: "5401" }]);
  });

  it("books the new row to a voucher in the same confirmation, linked to the new id", async () => {
    const client = new StagedClient(reads([voucherRoute(voucherRow())]), [
      POST,
      { method: "PUT", path: "/Voucher/2001/bookAmount", response: { body: { objects: {} } } },
      transactionRoute(created({ status: "400" })),
      accountRoute(IMPORT),
      voucherRoute(voucherRow({ status: "1000", paidAmount: "298.1" })),
      logRoute(5401, [logEntry(9001, 5401, "Voucher", 2001, -298.1)]),
    ]);
    const args = { ...ARGS, allocations: [{ kind: "voucher", id: 2001 }] };
    const { plan, output } = await executeWrite(tool, args, client);
    expect(plan.preview.action).toBe(
      "Enter a bank transaction of -298.10 EUR (outgoing) dated 2026-11-16 on file-import " +
        "account Import-Konto (id 4004), and book it to voucher 2001.",
    );
    expect(plan.preview.facts).toContainEqual({
      label: "Status afterwards",
      value: "booked (400)",
    });
    expect(plan.preview.facts.find((fact) => fact.label.startsWith("Allocation 1"))).toEqual({
      label: "Allocation 1: voucher 2001",
      value: expect.stringContaining("298.10 EUR (full payment, amount defaulted)") as unknown,
    });
    expect(plan.preview.warnings.at(-1)).toContain("To undo, use sevdesk_transaction_reset");
    expect(plan.previewDe.action).toBe(
      "Kontoumsatz über -298,10 EUR (Ausgang) vom 16.11.2026 auf dem Dateiimport-Konto " +
        "Import-Konto (ID 4004) anlegen und zuordnen zu Beleg 2001.",
    );
    expect(client.writes().map((call) => [call.method, call.path])).toEqual([
      ["POST", "/CheckAccountTransaction"],
      ["PUT", "/Voucher/2001/bookAmount"],
    ]);
    expect(client.writes()[1]?.body).toEqual({
      amount: -298.1,
      date: bookingTimestamp("2026-11-16"),
      type: "FULL_PAYMENT",
      checkAccount: { id: 4004, objectName: "CheckAccount" },
      checkAccountTransaction: { id: 5401, objectName: "CheckAccountTransaction" },
    });
    expect(output.data.bookings).toEqual([
      expect.objectContaining({
        document: expect.objectContaining({ kind: "voucher", id: 2001 }) as unknown,
        amount: { amount: "298.10", currency: "EUR" },
        paymentType: "payment",
      }),
    ]);
    expect(output.data.remaining).toEqual({ amount: "0.00", currency: "EUR" });
    expect(output.summary).toBe(
      "Bank transaction 5401 created and booked to 1 document; 0.00 EUR left unassigned.",
    );
    expect(output.affected).toEqual([
      { objectName: "Voucher", id: "2001" },
      { objectName: "CheckAccountTransaction", id: "5401" },
    ]);
  });

  it("refuses an allocation the new row cannot pay before anything is sent", async () => {
    // An invoice needs money in; the new row is outgoing.
    const client = new StagedClient(reads([invoiceRoute(invoiceRow())]), [POST]);
    const error = await prepareWrite(
      tool,
      { ...ARGS, allocations: [{ kind: "invoice", id: 1001 }] },
      client,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      kind: "validation",
      message:
        "Invoice 1001 needs incoming money, but the new bank transaction is outgoing. Invoices " +
        "and revenue vouchers take incoming payments; credit notes and expense vouchers " +
        "outgoing ones.",
    });
    expect(client.writes()).toEqual([]);
  });

  it("reports the created row as a completed write when its booking fails", async () => {
    const refused = new SevdeskError({
      kind: "validation",
      status: 422,
      message: "sevDesk rejected the request: validation error (HTTP 422).",
      upstreamMessage: "Voucher is not bookable with given payment information",
    });
    const client = new StagedClient(reads([voucherRoute(voucherRow())]), [
      POST,
      { method: "PUT", path: "/Voucher/2001/bookAmount", response: { error: refused } },
    ]);
    const error = await executeWrite(
      tool,
      { ...ARGS, allocations: [{ kind: "voucher", id: 2001 }] },
      client,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).completedWrites).toEqual([
      { objectName: "CheckAccountTransaction", id: "5401" },
    ]);
  });

  it.each([
    [4001, "clearing account (Verrechnungskonto, offline)"],
    [4002, "connected to a bank (or PayPal)"],
    [4003, "cash register (Kasse)"],
  ])("refuses account %d before anything is sent", async (id, kind) => {
    const client = new StagedClient(
      [accountRoute(accountRow(id)), accountsListRoute(), dayRows()],
      [POST],
    );
    const error = await prepareWrite(tool, { ...ARGS, checkAccountId: id }, client).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ kind: "validation" });
    expect((error as SevdeskError).message).toContain(kind);
    expect(client.writes()).toEqual([]);
  });

  it("validates its arguments", () => {
    expect(tool.input.safeParse({ ...ARGS, amount: "0" }).success).toBe(false);
    expect(tool.input.safeParse({ ...ARGS, amount: "-5" }).success).toBe(false);
    expect(tool.input.safeParse({ ...ARGS, amount: "1.234" }).success).toBe(false);
    expect(tool.input.safeParse({ ...ARGS, direction: "sideways" }).success).toBe(false);
    expect(tool.input.safeParse({ ...ARGS, counterparty: "  " }).success).toBe(false);
    expect(tool.input.safeParse({ ...ARGS, date: "2026-02-30" }).success).toBe(false);
    expect(tool.input.safeParse({ ...ARGS, allocations: [] }).success).toBe(false);
    expect(tool.input.safeParse({ ...ARGS, purpose: undefined }).success).toBe(true);
  });
});
