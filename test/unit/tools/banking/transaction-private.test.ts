import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { transactionMarkPrivateTool as tool } from "../../../../src/tools/banking/transaction-private.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  accountRoute,
  accountRow,
  StagedClient,
  transactionRoute,
  transactionRow,
} from "../../domain/reconciliation/helpers.js";

const OUTGOING = transactionRow({
  amount: "-45.99",
  payeePayerName: "Max Mustermann",
  paymtPurpose: "Privat",
});

function client(transaction = OUTGOING, after = { ...transaction, status: "300" }): StagedClient {
  return new StagedClient(
    [transactionRoute(transaction), accountRoute(accountRow(4002))],
    [
      {
        method: "PUT",
        path: "/CheckAccountTransaction/5101",
        response: { body: { objects: after } },
      },
      transactionRoute(after),
      accountRoute(accountRow(4002)),
    ],
  );
}

describe("sevdesk_transaction_mark_private", () => {
  it("is a commit tool with commit annotations", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.annotations.destructiveHint).toBe(true);
    expect(tool.annotations.idempotentHint).toBe(false);
  });

  it("previews a Privatentnahme for money out", async () => {
    const fake = client();
    const plan = await prepareWrite(tool, { id: 5101 }, fake);
    expect(plan.preview.action).toBe(
      "Mark bank transaction 5101 as private (Privatentnahme, status 100 → 300).",
    );
    expect(plan.preview.facts.at(-1)).toEqual({
      label: "Becomes",
      value: expect.stringContaining("Privatentnahme (private withdrawal)") as unknown,
    });
    expect(plan.preview.facts).toContainEqual({ label: "Counterparty", value: "Max Mustermann" });
    expect(plan.preview.warnings).toHaveLength(2);
    expect(plan.previewDe.action).toBe(
      "Kontoumsatz 5101 als privat markieren (Privatentnahme, Status 100 → 300).",
    );
    expect(plan.previewDe.facts.at(-1)).toEqual({
      label: "Wird zu",
      value:
        "Privatentnahme: Der Inhaber hat dieses Geld für private Zwecke aus dem Unternehmen " +
        "entnommen; es ist keine Betriebsausgabe.",
    });
    expect(plan.previewDe.facts).toContainEqual({
      label: "Auftraggeber/Empfänger",
      value: "Max Mustermann",
    });
    expect(plan.previewDe.warnings).toEqual([
      expect.stringContaining("zählt nicht mehr zu den betrieblichen Einnahmen und Ausgaben"),
      "Kapitalgesellschaften (GmbH, UG, AG) kennen keine Privatentnahmen oder Privateinlagen; " +
        "dort wäre das eine falsche Buchung.",
    ]);
    expect(fake.writes()).toEqual([]);
  });

  it("previews a Privateinlage for money in", async () => {
    const plan = await prepareWrite(tool, { id: 5101 }, client(transactionRow({ amount: "500" })));
    expect(plan.preview.action).toContain("Privateinlage");
    expect(plan.previewDe.action).toContain("(Privateinlage, Status 100 → 300)");
    expect(plan.previewDe.facts.at(-1)?.value).toContain(
      "aus privaten Mitteln in das Unternehmen eingelegt; es ist keine Betriebseinnahme",
    );
    expect(plan.previewDe.facts[0]?.value).toContain("(Eingang)");
  });

  it("sends status 300 with the commit tier and reads the transaction back", async () => {
    const fake = client();
    const { output } = await executeWrite(tool, { id: 5101 }, fake);
    expect(fake.writes()).toEqual([
      expect.objectContaining({
        method: "PUT",
        path: "/CheckAccountTransaction/5101",
        body: { status: 300 },
        tier: "commit",
      }),
    ]);
    expect(output.data.transaction.status?.code).toBe(300);
    expect(output.affected).toEqual([{ objectName: "CheckAccountTransaction", id: "5101" }]);
    expect(output.summary).toMatch(/^Bank transaction 5101 marked private; status .+ \(300\)\.$/);
  });

  it("refuses what cannot be marked, before anything is sent", async () => {
    for (const [overrides, text] of [
      [{ status: "400" }, "only unbooked transactions (status 100)"],
      [{ status: "300" }, "is already marked as private"],
      [{ enshrined: "2026-01-01T00:00:00+01:00" }, "is enshrined"],
      [{ amount: "0" }, "has the amount zero"],
    ] as const) {
      const fake = client(transactionRow(overrides));
      const error = await prepareWrite(tool, { id: 5101 }, fake).catch((e: unknown) => e);
      expect((error as SevdeskError).message).toContain(text);
      expect(fake.writes()).toEqual([]);
    }
  });

  it("refuses an unknown transaction with a hint", async () => {
    const fake = new StagedClient(
      [
        {
          path: "/CheckAccountTransaction/5101",
          response: { error: new SevdeskError({ kind: "not_found", message: "x" }) },
        },
      ],
      [],
    );
    await expect(prepareWrite(tool, { id: 5101 }, fake)).rejects.toMatchObject({
      kind: "validation",
      message: "Bank transaction 5101 does not exist; find it with sevdesk_transactions_list.",
    });
  });

  it("reports the change when the read-back fails", async () => {
    const fake = new StagedClient(
      [transactionRoute(OUTGOING), accountRoute(accountRow(4002))],
      [
        {
          method: "PUT",
          path: "/CheckAccountTransaction/5101",
          response: { body: { objects: {} } },
        },
        {
          path: "/CheckAccountTransaction/5101",
          response: { error: new SevdeskError({ kind: "timeout", message: "slow" }) },
        },
      ],
    );
    const error = (await executeWrite(tool, { id: 5101 }, fake).catch(
      (e: unknown) => e,
    )) as SevdeskError;
    expect(error.kind).toBe("timeout");
    expect(error.completedWrites).toEqual([{ objectName: "CheckAccountTransaction", id: "5101" }]);
  });
});
