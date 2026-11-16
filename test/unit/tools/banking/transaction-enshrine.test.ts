import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { transactionEnshrineTool as tool } from "../../../../src/tools/banking/transaction-enshrine.js";
import { ACCOUNT_BOOKINGS } from "../../../../src/tools/types.js";
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountRoute,
  accountRow,
  logEntry,
  logRoute,
  type Row,
  StagedClient,
  transactionRoute,
  transactionRow,
} from "../../domain/reconciliation/helpers.js";

const IMPORT = accountRow(4004, { status: "100", name: "Import-Konto" });
const ENSHRINED = "2026-11-16T22:00:00+01:00";

function row(overrides: Row = {}): Row {
  return transactionRow({
    id: "5401",
    amount: "-20",
    status: "400",
    valueDate: "2026-11-16T12:00:00+01:00",
    payeePayerName: "Beispiel Lieferant AG",
    paymtPurpose: "RE-2026-0042",
    checkAccount: { id: "4004", objectName: "CheckAccount" },
    ...overrides,
  });
}

const ENSHRINE: FakeRoute = {
  method: "PUT",
  path: "/CheckAccountTransaction/5401/enshrine",
  response: { body: { objects: null } },
};

function reads(transaction: Row = row(), log: readonly Row[] = []): FakeRoute[] {
  return [
    transactionRoute(transaction),
    accountRoute(IMPORT),
    logRoute(5401, log.length > 0 ? log : [logEntry(7001, 5401, "Voucher", 2001, -20)]),
  ];
}

describe("sevdesk_transaction_enshrine", () => {
  it("is a commit tool marked destructive that locks the row and the bookings", () => {
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

  it("previews an irreversible lock in both languages and names the documents it pays", async () => {
    const client = new StagedClient(reads(), []);
    const plan = await prepareWrite(tool, { id: 5401 }, client);
    expect(plan.preview.irreversible).toBe(true);
    expect(plan.previewDe.irreversible).toBe(true);
    expect(plan.preview.action).toBe(
      "Enshrine bank transaction 5401 (festschreiben, GoBD): lock it permanently.",
    );
    expect(plan.previewDe.action).toBe("Kontoumsatz 5401 festschreiben (GoBD): dauerhaft sperren.");
    expect(plan.preview.facts.at(-1)).toEqual({ label: "Booked to", value: "voucher 2001" });
    expect(plan.previewDe.facts.at(-1)).toEqual({ label: "Gebucht auf", value: "Beleg 2001" });
    expect(plan.preview.warnings).toEqual([
      "Irreversible (GoBD): sevDesk never changes this bank transaction again: no status change, " +
        "no deletion, and its bookings can no longer be undone (sevdesk_transaction_reset).",
      "The documents it pays can no longer be reset to open: their payment from this transaction " +
        "stays for good, so a correction needs a new document (for an invoice a cancellation or " +
        "a credit note).",
      "The documents themselves are not enshrined by this; their own enshrine tools do that " +
        "(sevdesk_invoice_enshrine, sevdesk_voucher_enshrine, sevdesk_credit_note_enshrine).",
    ]);
    expect(plan.previewDe.warnings[0]).toBe(
      "Nicht umkehrbar (GoBD): sevDesk ändert diesen Kontoumsatz danach nie wieder: kein " +
        "Statuswechsel, kein Löschen, und seine Buchungen lassen sich nicht mehr rückgängig " +
        "machen (sevdesk_transaction_reset).",
    );
    expect(plan.previewDe.warnings[1]).toContain(
      "Die Dokumente, die er bezahlt, lassen sich nicht mehr auf offen zurücksetzen",
    );
    expect(client.writes()).toEqual([]);
  });

  it("warns that the rest of a partly linked row may not be bookable afterwards", async () => {
    const plan = await prepareWrite(
      tool,
      { id: 5401 },
      new StagedClient(reads(row({ status: "200" })), []),
    );
    expect(plan.preview.warnings.at(-1)).toContain("still unassigned (status 200)");
    expect(plan.previewDe.warnings.at(-1)).toContain("noch nicht zugeordnet (Status 200)");
  });

  it("says when a private row pays no document", async () => {
    const client = new StagedClient(
      [transactionRoute(row({ status: "300" })), accountRoute(IMPORT), logRoute(5401, [])],
      [],
    );
    const plan = await prepareWrite(tool, { id: 5401 }, client);
    expect(plan.preview.facts.at(-1)).toEqual({
      label: "Booked to",
      value: "no document (private)",
    });
    expect(plan.previewDe.facts.at(-1)).toEqual({
      label: "Gebucht auf",
      value: "kein Dokument (privat)",
    });
  });

  it("locks the row and reads back enshrined", async () => {
    const client = new StagedClient(reads(), [
      ENSHRINE,
      transactionRoute(row({ enshrined: ENSHRINED })),
      accountRoute(IMPORT),
    ]);
    const { output } = await executeWrite(tool, { id: 5401 }, client);
    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "PUT",
        path: "/CheckAccountTransaction/5401/enshrine",
        tier: "commit",
      }),
    ]);
    expect(output.data.transaction.enshrined).toBe(true);
    expect(output.summary).toBe("Bank transaction 5401 enshrined (festgeschrieben).");
    expect(output.affected).toEqual([{ objectName: "CheckAccountTransaction", id: "5401" }]);
  });

  it.each([
    ["an unbooked row (status 100)", row({ status: "100" }), "unbooked (status 100)"],
    ["an enshrined row", row({ enshrined: ENSHRINED }), "already enshrined"],
    ["a deleted row", row({ status: "100", deletedAt: ENSHRINED }), "was deleted"],
  ])("refuses %s before anything is sent", async (_label, transaction, text) => {
    const client = new StagedClient(reads(transaction), [ENSHRINE]);
    const error = await prepareWrite(tool, { id: 5401 }, client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).message).toContain(text);
    expect(client.writes()).toEqual([]);
  });
});
