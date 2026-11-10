import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { transactionResetTool as tool } from "../../../../src/tools/banking/transaction-reset.js";
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountRoute,
  accountRow,
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

const SPLIT = transactionRow({ id: "5201", amount: "238", status: "400" });
const SPLIT_LOG = [
  logEntry(7001, 5201, "Invoice", 1001, 119),
  logEntry(7002, 5201, "Invoice", 1002, 119),
];

function paidInvoice(id: number, paid: string, status = "1000"): Row {
  return invoiceRow({
    id: String(id),
    invoiceNumber: `RE-${String(id)}`,
    status,
    sumGross: "119",
    sumNet: "100",
    sumTax: "19",
    paidAmount: paid,
  });
}

function put(
  path: string,
  response: FakeRoute["response"] = { body: { objects: null } },
): FakeRoute {
  return { method: "PUT", path, response };
}

function linkedClient(after: readonly FakeRoute[]): StagedClient {
  return new StagedClient(
    [
      transactionRoute(SPLIT),
      accountRoute(accountRow(4002)),
      logRoute(5201, SPLIT_LOG),
      invoiceRoute(paidInvoice(1001, "119")),
      invoiceRoute(paidInvoice(1002, "119")),
    ],
    after,
  );
}

describe("sevdesk_transaction_reset", () => {
  it("is a commit tool with commit annotations", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it("previews resetting every linked document with its share and the collateral rule", async () => {
    const client = linkedClient([]);
    const plan = await prepareWrite(tool, { id: 5201 }, client);
    expect(plan.preview.action).toBe(
      "Undo the bookings of bank transaction 5201: reset 2 documents to open (invoice RE-1001, " +
        "invoice RE-1002), removing all their payments.",
    );
    const documentFacts = plan.preview.facts.filter((f) => f.label.startsWith("Document"));
    expect(documentFacts).toEqual([
      {
        label: "Document 1: invoice RE-1001",
        value: expect.stringMatching(
          /^status .+ \(1000\) → open \(200\); this transaction paid 119\.00 EUR; other payments removed too: 0\.00 EUR$/,
        ) as unknown,
      },
      expect.objectContaining({ label: "Document 2: invoice RE-1002" }),
    ]);
    expect(plan.preview.warnings[0]).toContain("removes ALL payments booked on it");
    expect(plan.previewDe.action).toBe(
      "Buchungen des Kontoumsatzes 5201 rückgängig machen: 2 Dokumente auf offen zurücksetzen " +
        "(Rechnung RE-1001, Rechnung RE-1002) und dabei alle ihre Zahlungen entfernen.",
    );
    expect(plan.previewDe.facts.filter((f) => f.label.startsWith("Dokument"))).toEqual([
      {
        label: "Dokument 1: Rechnung RE-1001",
        value:
          "Status Bezahlt (1000) → offen (200); dieser Umsatz hat 119,00 EUR bezahlt; weitere " +
          "entfernte Zahlungen: 0,00 EUR",
      },
      expect.objectContaining({ label: "Dokument 2: Rechnung RE-1002" }),
    ]);
    expect(plan.previewDe.warnings[0]).toContain(
      "das entfernt ALLE darauf gebuchten Zahlungen, nicht nur die dieses Umsatzes",
    );
    expect(plan.preview.irreversible).toBe(false);
    expect(client.writes()).toEqual([]);
  });

  it("resets each document to open in order and reads everything back", async () => {
    const client = linkedClient([
      put("/Invoice/1001/resetToOpen"),
      put("/Invoice/1002/resetToOpen"),
      transactionRoute({ ...SPLIT, status: "100" }),
      accountRoute(accountRow(4002)),
      invoiceRoute(paidInvoice(1001, "0", "200")),
      invoiceRoute(paidInvoice(1002, "0", "200")),
    ]);
    const { output } = await executeWrite(tool, { id: 5201 }, client);
    expect(client.writes().map((w) => [w.method, w.path, w.tier, w.body])).toEqual([
      ["PUT", "/Invoice/1001/resetToOpen", "commit", undefined],
      ["PUT", "/Invoice/1002/resetToOpen", "commit", undefined],
    ]);
    expect(output.data.transaction?.status?.code).toBe(100);
    expect(output.data.documents.map((d) => [d.id, d.status?.code])).toEqual([
      [1001, 200],
      [1002, 200],
    ]);
    expect(output.affected).toEqual([
      { objectName: "Invoice", id: "1001" },
      { objectName: "Invoice", id: "1002" },
      { objectName: "CheckAccountTransaction", id: "5201" },
    ]);
    expect(output.summary).toMatch(
      /^Reset 2 documents to open; bank transaction 5201 has status .+ \(100\)\.$/,
    );
  });

  it("lists the other transactions a reset unlinks, in the preview and in affected", async () => {
    const reads = [
      transactionRoute(SPLIT),
      accountRoute(accountRow(4002)),
      logRoute(5201, SPLIT_LOG),
      invoiceRoute({ ...paidInvoice(1001, "177.33"), sumGross: "177.33" }),
      invoiceRoute(paidInvoice(1002, "119")),
      listRoute("/CheckAccountTransactionLog", [
        ...SPLIT_LOG,
        logEntry(7003, 5302, "Invoice", 1001, 58.33),
      ]),
    ];
    const failure = new SevdeskError({ kind: "validation", status: 422, message: "322" });
    const partial = new StagedClient(reads, [
      put("/Invoice/1001/resetToOpen"),
      put("/Invoice/1002/resetToOpen", { error: failure }),
    ]);
    const plan = await prepareWrite(tool, { id: 5201 }, partial);
    expect(plan.preview.facts).toContainEqual({
      label: "Other bank transactions changed",
      value: "5302 (→ unbooked 100)",
    });
    expect(plan.preview.facts).toContainEqual({
      label: "This transaction after the reset",
      value: "unbooked (status 100), or deleted if sevDesk created it for a booking",
    });
    expect(plan.preview.facts.find((f) => f.label.startsWith("Document 1"))?.value).toContain(
      "; also unlinks bank transactions 5302 (58.33 EUR)",
    );
    expect(plan.previewDe.facts).toContainEqual({
      label: "Weitere geänderte Kontoumsätze",
      value: "5302 (→ ungebucht 100)",
    });
    expect(plan.previewDe.facts).toContainEqual({
      label: "Dieser Umsatz nach dem Zurücksetzen",
      value:
        "ungebucht (Status 100) oder gelöscht, falls sevDesk ihn für eine Buchung angelegt hat",
    });
    expect(plan.previewDe.facts.find((f) => f.label.startsWith("Dokument 1"))?.value).toContain(
      "; löst auch die Kontoumsätze 5302 (58,33 EUR)",
    );
    expect(plan.previewDe.warnings.join(" ")).toContain(
      "verliert auch die Zahlungen aus Kontoumsatz 5302 (58,33 EUR, danach ungebucht (100))",
    );
    const error = (await executeWrite(tool, { id: 5201 }, partial).catch(
      (e: unknown) => e,
    )) as SevdeskError;
    expect(error.completedWrites).toEqual([
      { objectName: "Invoice", id: "1001" },
      { objectName: "CheckAccountTransaction", id: "5201" },
      { objectName: "CheckAccountTransaction", id: "5302" },
    ]);

    const full = new StagedClient(reads, [
      put("/Invoice/1001/resetToOpen"),
      put("/Invoice/1002/resetToOpen"),
      transactionRoute({ ...SPLIT, status: "100" }),
      accountRoute(accountRow(4002)),
      invoiceRoute(paidInvoice(1001, "0", "200")),
      invoiceRoute(paidInvoice(1002, "0", "200")),
    ]);
    const { output } = await executeWrite(tool, { id: 5201 }, full);
    expect(output.affected).toEqual([
      { objectName: "Invoice", id: "1001" },
      { objectName: "Invoice", id: "1002" },
      { objectName: "CheckAccountTransaction", id: "5201" },
      { objectName: "CheckAccountTransaction", id: "5302" },
    ]);
  });

  it("reports a transaction sevDesk deleted with the reset", async () => {
    const transaction = transactionRow({
      id: "5201",
      amount: "-298.1",
      status: "400",
      checkAccount: { id: "4001", objectName: "CheckAccount" },
    });
    const client = new StagedClient(
      [
        transactionRoute(transaction),
        accountRoute(accountRow(4001)),
        logRoute(5201, [logEntry(1, 5201, "Voucher", 2001, -298.1)]),
        voucherRoute(voucherRow({ status: "1000", paidAmount: "298.1", enshrined: null })),
      ],
      [
        put("/Voucher/2001/resetToOpen"),
        {
          path: "/CheckAccountTransaction/5201",
          response: { error: new SevdeskError({ kind: "not_found", message: "gone" }) },
        },
        voucherRoute(voucherRow({ status: "100", paidAmount: "0", enshrined: null })),
      ],
    );
    const { plan, output } = await executeWrite(tool, { id: 5201 }, client);
    expect(plan.preview.warnings.at(-1)).toContain("deleted by the reset");
    expect(plan.previewDe.warnings.at(-1)).toContain(
      "ein solcher Umsatz wird beim Zurücksetzen gelöscht und nicht auf ungebucht gesetzt",
    );
    expect(output.data).toMatchObject({ transactionDeleted: true });
    expect(output.data.transaction).toBeUndefined();
    expect(output.summary).toBe(
      "Reset 1 document to open; bank transaction 5201 was deleted by sevDesk (it had created " +
        "it for a booking).",
    );
  });

  it("names the documents already reset when a later reset fails", async () => {
    const failure = new SevdeskError({ kind: "validation", status: 422, message: "322" });
    const client = linkedClient([
      put("/Invoice/1001/resetToOpen"),
      put("/Invoice/1002/resetToOpen", { error: failure }),
    ]);
    const error = (await executeWrite(tool, { id: 5201 }, client).catch(
      (e: unknown) => e,
    )) as SevdeskError;
    expect(error.completedWrites).toEqual([
      { objectName: "Invoice", id: "1001" },
      { objectName: "CheckAccountTransaction", id: "5201" },
    ]);
  });

  it("passes a failure of the first reset on unchanged", async () => {
    const failure = new SevdeskError({ kind: "validation", status: 422, message: "322" });
    const client = linkedClient([put("/Invoice/1001/resetToOpen", { error: failure })]);
    const error = await executeWrite(tool, { id: 5201 }, client).catch((e: unknown) => e);
    expect(error).toBe(failure);
  });

  it("reports the resets when a read-back fails (other than a deleted transaction)", async () => {
    const client = linkedClient([
      put("/Invoice/1001/resetToOpen"),
      put("/Invoice/1002/resetToOpen"),
      {
        path: "/CheckAccountTransaction/5201",
        response: { error: new SevdeskError({ kind: "server", message: "boom" }) },
      },
    ]);
    const error = (await executeWrite(tool, { id: 5201 }, client).catch(
      (e: unknown) => e,
    )) as SevdeskError;
    expect(error.kind).toBe("server");
    expect(error.completedWrites).toHaveLength(3);
  });

  it("sets a private transaction back to unbooked", async () => {
    const privateRow = transactionRow({ status: "300", amount: "-45.99" });
    const client = new StagedClient(
      [transactionRoute(privateRow), accountRoute(accountRow(4002))],
      [
        put("/CheckAccountTransaction/5101", {
          body: { objects: { ...privateRow, status: "100" } },
        }),
        transactionRoute({ ...privateRow, status: "100" }),
        accountRoute(accountRow(4002)),
      ],
    );
    const { plan, output } = await executeWrite(tool, { id: 5101 }, client);
    expect(plan.preview.action).toBe(
      "Set bank transaction 5101 back from private to unbooked (status 300 → 100).",
    );
    expect(plan.previewDe.action).toBe(
      "Kontoumsatz 5101 von privat auf ungebucht zurücksetzen (Status 300 → 100).",
    );
    expect(plan.previewDe.warnings).toEqual([
      "Der Umsatz ist dann nicht mehr privat: Er gilt wieder als ungebucht und kann Dokumenten " +
        "zugeordnet werden (sevdesk_reconcile_suggest, sevdesk_transaction_book).",
    ]);
    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "PUT",
        path: "/CheckAccountTransaction/5101",
        body: { status: 100 },
        tier: "commit",
      }),
    ]);
    expect(output.data).toMatchObject({ documents: [], transaction: { id: 5101 } });
    expect(output.affected).toEqual([{ objectName: "CheckAccountTransaction", id: "5101" }]);
  });

  it("refuses an unbooked transaction before anything is sent", async () => {
    const client = new StagedClient(
      [transactionRoute(transactionRow()), accountRoute(accountRow(4002))],
      [],
    );
    await expect(prepareWrite(tool, { id: 5101 }, client)).rejects.toMatchObject({
      kind: "validation",
      message: "Bank transaction 5101 is not booked (status 100); there is nothing to reset.",
    });
    expect(client.writes()).toEqual([]);
  });
});
