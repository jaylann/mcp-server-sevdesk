import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { transactionDeleteTool as tool } from "../../../../src/tools/banking/transaction-delete.js";
import { ACCOUNT_BOOKINGS } from "../../../../src/tools/types.js";
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountRoute,
  accountRow,
  type Row,
  StagedClient,
  transactionRoute,
  transactionRow,
} from "../../domain/reconciliation/helpers.js";

/** An active file-import account (type online, importType CSV, no bank server; D-097). */
const IMPORT = accountRow(4004, { status: "100", name: "Import-Konto" });

function row(overrides: Row = {}): Row {
  return transactionRow({
    id: "5401",
    amount: "-11.9",
    status: "100",
    valueDate: "2026-11-16T12:00:00+01:00",
    payeePayerName: "Bäckerei Huber",
    paymtPurpose: "Kaffee",
    checkAccount: { id: "4004", objectName: "CheckAccount" },
    ...overrides,
  });
}

const DELETE: FakeRoute = {
  method: "DELETE",
  path: "/CheckAccountTransaction/5401",
  response: { body: { objects: [null] } },
};

/** Reads before the delete: the row and (twice: with the row, then on its own) its account. */
function reads(transaction: Row = row()): FakeRoute[] {
  return [transactionRoute(transaction), accountRoute(IMPORT)];
}

describe("sevdesk_transaction_delete", () => {
  it("is a commit tool with commit annotations that locks the row and the bookings", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tool.locks?.({ id: 5401, dryRun: false })).toEqual([
      ACCOUNT_BOOKINGS,
      { objectName: "CheckAccountTransaction", id: "5401" },
    ]);
  });

  it("previews that the row leaves the lists and the balance, in both languages", async () => {
    const client = new StagedClient(reads(), []);
    const plan = await prepareWrite(tool, { id: 5401 }, client);
    expect(plan.preview.action).toBe("Delete bank transaction 5401 (-11.90 EUR).");
    expect(plan.preview.facts[0]).toEqual({
      label: "Bank transaction (Umsatz)",
      value: "id 5401, -11.90 EUR (outgoing)",
    });
    expect(plan.preview.warnings).toEqual([
      "The row leaves the transaction lists and the account balance (Saldo), which changes by " +
        "11.90 EUR. sevDesk keeps it readable by id, marked as deleted.",
      "No tool restores a deleted row; if it was needed, enter it again with " +
        "sevdesk_transaction_create.",
    ]);
    expect(plan.preview.irreversible).toBe(true);
    expect(plan.previewDe.action).toBe("Kontoumsatz 5401 (-11,90 EUR) löschen.");
    expect(plan.previewDe.warnings[0]).toBe(
      "Der Umsatz verschwindet aus den Umsatzlisten und aus dem Saldo des Kontos, der sich um " +
        "11,90 EUR ändert. sevDesk hält ihn über seine ID weiter lesbar, als gelöscht markiert.",
    );
    expect(client.writes()).toEqual([]);
  });

  it("deletes the row and reports it deleted from the read-back (soft delete, D-096)", async () => {
    const client = new StagedClient(reads(), [
      DELETE,
      transactionRoute(row({ deletedAt: "2026-11-16T22:01:00+01:00" })),
      accountRoute(IMPORT),
    ]);
    const { output } = await executeWrite(tool, { id: 5401 }, client);
    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "DELETE",
        path: "/CheckAccountTransaction/5401",
        tier: "commit",
      }),
    ]);
    expect(output.data.transaction).toMatchObject({
      id: 5401,
      deleted: true,
      deletedOn: "2026-11-16",
    });
    expect(output.summary).toBe(
      "Bank transaction 5401 deleted on 2026-11-16: it is no longer in the lists or the balance " +
        "(sevDesk keeps it readable by id).",
    );
    expect(output.affected).toEqual([{ objectName: "CheckAccountTransaction", id: "5401" }]);
  });

  it("does not take a 2xx without deletedAt for a deletion", async () => {
    const client = new StagedClient(reads(), [
      DELETE,
      transactionRoute(row()),
      accountRoute(IMPORT),
    ]);
    const error = await executeWrite(tool, { id: 5401 }, client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SevdeskError);
    expect(error).toMatchObject({
      kind: "unexpected_response",
      completedWrites: [{ objectName: "CheckAccountTransaction", id: "5401" }],
    });
  });

  it.each([
    ["a booked row", row({ status: "400" }), "sevdesk_transaction_reset first"],
    ["a private row", row({ status: "300" }), "Set it back to unbooked"],
    [
      "an enshrined row",
      row({ status: "400", enshrined: "2026-11-16T22:00:00+01:00" }),
      "never deletes it",
    ],
    ["a deleted row", row({ deletedAt: "2026-11-16T22:01:00+01:00" }), "there is nothing to do"],
  ])("refuses %s before anything is sent", async (_label, transaction, text) => {
    const client = new StagedClient(reads(transaction), [DELETE]);
    const error = await prepareWrite(tool, { id: 5401 }, client).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "validation" });
    expect((error as SevdeskError).message).toContain(text);
    expect(client.writes()).toEqual([]);
  });

  it.each([
    [4001, "clearing account (Verrechnungskonto)"],
    [4002, "bank-connected account"],
    [4003, "cash register (Kasse)"],
  ])("refuses rows of account %d, naming what undoes them", async (id, kind) => {
    const transaction = row({ checkAccount: { id: String(id), objectName: "CheckAccount" } });
    const client = new StagedClient(
      [transactionRoute(transaction), accountRoute(accountRow(id))],
      [DELETE],
    );
    const error = await prepareWrite(tool, { id: 5401 }, client).catch((e: unknown) => e);
    expect((error as SevdeskError).message).toContain(kind);
    expect(client.writes()).toEqual([]);
  });
});
