import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { transactionGetTool as tool } from "../../../../src/tools/banking/transaction-get.js";
import { withCountryRoute } from "../../../helpers/country-route.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";
import {
  accountRoute,
  accountRow,
  creditNoteRoute,
  creditNoteRow,
  invoiceRoute,
  invoiceRow,
  logEntry,
  logRoute,
  transactionRoute,
  transactionRow,
} from "../../domain/reconciliation/helpers.js";

async function run(routes: readonly FakeRoute[], id = 5201) {
  const client = new FakeSevdeskClient(withCountryRoute(routes));
  const result = await tool.handler(tool.input.parse({ id }), testContext(client));
  tool.output.parse(result.data);
  return { client, result };
}

const SPLIT = transactionRow({
  id: "5201",
  amount: "238",
  status: "400",
  payeePayerAcctNo: "DE89 3704 0044 0532 0130 00",
});

describe("sevdesk_transaction_get", () => {
  it("is a read tool with read annotations", () => {
    expect(tool.tier).toBe("read");
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("shows the assignments with their documents and the remaining amount", async () => {
    const { client, result } = await run([
      transactionRoute(SPLIT),
      accountRoute(accountRow(4002)),
      logRoute(5201, [
        logEntry(7001, 5201, "Invoice", 1001, 119),
        logEntry(7002, 5201, "Invoice", 1002, 119),
      ]),
      invoiceRoute(invoiceRow({ status: "1000", paidAmount: "119" })),
      invoiceRoute(invoiceRow({ id: "1002", invoiceNumber: "RE-1002", status: "1000" })),
    ]);
    expect(result.data.transaction.id).toBe(5201);
    expect(result.data.counterpartyIbanMasked).toBe("****3000");
    expect(result.data.assignments).toEqual([
      {
        logEntryId: 7001,
        document: {
          kind: "invoice",
          id: 1001,
          number: "RE-1001",
          status: { code: 1000, key: "paid", label: expect.any(String) as unknown },
          contact: { id: 1001, name: "Musterfirma GmbH" },
          gross: { amount: "177.33", currency: "EUR" },
          paid: { amount: "119.00", currency: "EUR" },
        },
        amount: { amount: "119.00", currency: "EUR" },
        bookingDate: "2026-11-02",
      },
      expect.objectContaining({
        logEntryId: 7002,
        document: expect.objectContaining({ id: 1002 }) as unknown,
      }),
    ]);
    expect(result.data.assigned).toEqual({ amount: "238.00", currency: "EUR" });
    expect(result.data.remaining).toEqual({ amount: "0.00", currency: "EUR" });
    expect(result.summary).toBe("Bank transaction 5201: 2 assignments, 0.00 EUR unassigned.");
    expect(client.writes()).toEqual([]);
  });

  it("reads each document once and marks others and unreadable ones", async () => {
    const missing: FakeRoute = {
      path: "/CreditNote/2001",
      query: { embed: "contact" },
      response: { error: new SevdeskError({ kind: "not_found", message: "x" }) },
    };
    const { client, result } = await run([
      transactionRoute(transactionRow({ id: "5201", amount: "238", status: "200" })),
      accountRoute(accountRow(4002)),
      logRoute(5201, [
        logEntry(1, 5201, "Invoice", 1001, 50),
        logEntry(2, 5201, "Invoice", 1001, 50),
        logEntry(3, 5201, "Order", 3001, 10),
        logEntry(4, 5201, "CreditNote", 2001, 10),
        logEntry(5, 5201, "Invoice", 1001, null),
      ]),
      invoiceRoute(invoiceRow()),
      missing,
    ]);
    expect(client.callsTo("/Invoice/1001")).toHaveLength(1);
    expect(result.data.assignments.map((a) => a.document?.kind)).toEqual([
      "invoice",
      "invoice",
      "other",
      "credit_note",
      "invoice",
    ]);
    expect(result.data.assignments[2]?.document).toEqual({
      kind: "other",
      id: 3001,
      objectName: "Order",
    });
    expect(result.data.assignments[3]?.document).toEqual({
      kind: "credit_note",
      id: 2001,
      unreadable: true,
    });
    expect(result.data.assignments[4]?.amount).toBeUndefined();
    expect(result.data.remainingUnknown).toBe("its booking log has an entry without an amount");
    expect(result.summary).toBe(
      "Bank transaction 5201: 5 assignments; the unassigned amount is unknown (its booking log " +
        "has an entry without an amount).",
    );
  });

  it("stops reading documents after ten and passes other read failures on", async () => {
    const log = Array.from({ length: 12 }, (_, i) => logEntry(i + 1, 5201, "Invoice", 1100 + i, 1));
    const documents = Array.from({ length: 12 }, (_, i) =>
      invoiceRoute(invoiceRow({ id: String(1100 + i) })),
    );
    const { result } = await run([
      transactionRoute(transactionRow({ id: "5201", amount: "238", status: "200" })),
      accountRoute(accountRow(4002)),
      logRoute(5201, log),
      ...documents,
    ]);
    expect(result.data.assignments.filter((a) => a.document?.unreadable === true)).toHaveLength(2);

    const failing = new FakeSevdeskClient(
      withCountryRoute([
        transactionRoute(SPLIT),
        accountRoute(accountRow(4002)),
        logRoute(5201, [logEntry(1, 5201, "Invoice", 1001, 238)]),
        {
          path: "/Invoice/1001",
          query: { embed: "contact" },
          response: { error: new SevdeskError({ kind: "auth", message: "no" }) },
        },
      ]),
    );
    await expect(tool.handler({ id: 5201 }, testContext(failing))).rejects.toMatchObject({
      kind: "auth",
    });
  });

  it("shows a free transaction with its whole amount unassigned and no IBAN", async () => {
    const { result } = await run(
      [
        transactionRoute(transactionRow({ amount: "-23.8" })),
        accountRoute(accountRow(4002)),
        logRoute(5101, []),
        creditNoteRoute(creditNoteRow()),
      ],
      5101,
    );
    expect(result.data.assignments).toEqual([]);
    expect(result.data.counterpartyIbanMasked).toBeUndefined();
    expect(result.data.remaining).toEqual({ amount: "23.80", currency: "EUR" });
    expect(result.summary).toBe("Bank transaction 5101: 0 assignments, 23.80 EUR unassigned.");
  });
});
