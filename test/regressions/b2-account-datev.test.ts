/**
 * B2: a voucher position's booking account must allow its tax rule and tax rate.
 *
 * sevDesk accepts a draft voucher with any account × tax rule combination: the M4 probe
 * (2026-11-08) saved an expense draft with revenue rule 1 at status 50 without complaint. It
 * refuses only when the voucher is booked, late and with unhelpful messages, or the wrong
 * combination ends up in the books (spec/deviations.md D-006, D-065). Other integrations sent
 * whatever the model chose.
 *
 * Guard: every voucher write (create, update with a new rule or new positions, finalize, the
 * e-invoice import) checks each position against sevDesk's ReceiptGuidance (`validateAccountTaxRule`,
 * cached `forAllAccounts`) in `prepare` and refuses with the allowed alternatives before anything
 * is sent. Our check is the only guard. Tested through the real HTTP client: no data-changing
 * request leaves it.
 */
import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../src/sevdesk/errors.js";
import { voucherCreateDraftTool } from "../../src/tools/vouchers/draft-create.js";
import { voucherUpdateDraftTool } from "../../src/tools/vouchers/draft-update.js";
import { voucherFinalizeTool } from "../../src/tools/vouchers/finalize.js";
import { jsonResponse } from "../helpers/fake-fetch.js";
import { executeWrite } from "../helpers/write-tools.js";
import { draftRow, positionRow } from "../unit/tools/vouchers/routes.js";
import { CREATE_ARGS, fixtureReply, wireClient } from "../unit/tools/vouchers/wire.js";

async function refused(run: Promise<unknown>): Promise<string> {
  const error = await run.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  return (error as SevdeskError).message;
}

const guidanceReads = () => [
  fixtureReply("meta/bookkeeping-system-version.json"),
  fixtureReply("drafts/sev-client.json"),
  fixtureReply("recorded/2026-11-07/meta/receipt-guidance-all.json"),
];

describe("B2: account × tax rule × rate is checked against ReceiptGuidance before any write", () => {
  it("refuses a revenue account on an expense voucher, with the allowed alternatives", async () => {
    const { client, fake } = wireClient(guidanceReads());
    const message = await refused(
      executeWrite(
        voucherCreateDraftTool,
        { ...CREATE_ARGS, positions: [{ accountDatevId: 5192, amount: "119", taxRate: 19 }] },
        client,
      ),
    );
    expect(message).toBe(
      "Position 1: account 5192 (no. 4400) cannot be used for expense receipts (allowed receipt " +
        "types: revenue). Pick an account for expense receipts with sevdesk_reference_lookup " +
        "kind=receipt_guidance receiptType=expense. Position 1: Tax rule 9 (VORST_ABZUGSF_AUFW) " +
        "is not allowed with account 5192 (no. 4400). Allowed tax rules: 1 " +
        "(USTPFL_UMS_EINN). Nothing was sent to sevDesk. The allowed combinations per account " +
        "are listed by sevdesk_reference_lookup kind=receipt_guidance.",
    );
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
    expect(fake.pending).toBe(0);
  });

  it("refuses a rate the account does not allow with the rule", async () => {
    const { client, fake } = wireClient(guidanceReads());
    // Account 4266 (6815 Bürobedarf) allows rule 8 at 0 % only.
    const message = await refused(
      executeWrite(
        voucherCreateDraftTool,
        {
          ...CREATE_ARGS,
          taxRuleId: 8,
          positions: [{ accountDatevId: 4266, amount: "119", taxRate: 19 }],
        },
        client,
      ),
    );
    expect(message).toContain(
      "Tax rate 19% is not allowed for tax rule 8 (INNERGEM_ERWERB) with account 4266 (no. 6815). " +
        "Allowed tax rates: 0%.",
    );
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("refuses an unknown account", async () => {
    const { client } = wireClient(guidanceReads());
    const message = await refused(
      executeWrite(
        voucherCreateDraftTool,
        { ...CREATE_ARGS, positions: [{ accountDatevId: 999_999, amount: "119", taxRate: 19 }] },
        client,
      ),
    );
    expect(message).toContain(
      "Account 999999 (accountDatev) is not an account receipts can be booked on",
    );
  });

  it("checks the stored positions again when an update changes the tax rule", async () => {
    const { client, fake } = wireClient([
      jsonResponse({ objects: [draftRow()] }),
      jsonResponse({ objects: [positionRow()], total: 1 }),
      ...guidanceReads(),
    ]);
    const message = await refused(
      executeWrite(voucherUpdateDraftTool, { id: 2101, taxRuleId: 12 }, client),
    );
    expect(message).toContain("Position 1 has a tax rate of 19 %, which tax rule 12");
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("checks a stored draft once more before it is finalized", async () => {
    const wrong = positionRow({ accountDatev: { id: "5192", objectName: "AccountDatev" } });
    const { client, fake } = wireClient([
      jsonResponse({ objects: [draftRow()] }),
      jsonResponse({ objects: [wrong], total: 1 }),
      ...guidanceReads(),
    ]);
    const message = await refused(executeWrite(voucherFinalizeTool, { id: 2101 }, client));
    expect(message).toContain("Position 1: account 5192 (no. 4400) cannot be used for expense");
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
  });
});
