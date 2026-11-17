import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { orderSetOfferStatusTool as tool } from "../../../../src/tools/orders/offer-status.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { sentOffer } from "../../../write-cases/orders.js";
import { documentRoute, positionRoutes, type Row, StagedClient } from "../lifecycle/helpers.js";

const offer = (overrides: Row): Row => ({ ...sentOffer, ...overrides });

/** Reads `before` until the PUT, then `after` (positions read for the approval binding). */
function staged(before: Row, after: Row): StagedClient {
  return new StagedClient(
    [documentRoute("order", before)],
    [
      { method: "PUT", path: "/Order/3001", response: { body: { objects: after } } },
      documentRoute("order", after),
      ...positionRoutes(),
    ],
  );
}

async function refusal(before: Row, action: string): Promise<string> {
  const client = staged(before, before);
  const error = await prepareWrite(tool, { id: 3001, action }, client).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  expect(client.writes()).toEqual([]);
  return (error as SevdeskError).message;
}

describe("sevdesk_order_set_offer_status (D-108)", () => {
  it("is a commit tool of the orders toolset that needs an action", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.toolset).toBe("orders");
    expect(tool.annotations.destructiveHint).toBe(true);
    expect(tool.input.safeParse({ id: 3001 }).success).toBe(false);
    expect(tool.input.safeParse({ id: 3001, action: "invoice" }).success).toBe(false);
    expect(tool.locks?.(tool.input.parse({ id: 3001, action: "accept" }))).toEqual([
      { objectName: "Order", id: "3001" },
    ]);
  });

  it("accepts a sent offer with a body of only the status, and reads it back", async () => {
    const client = staged(sentOffer, offer({ status: "500" }));
    const { plan, output } = await executeWrite(tool, { id: 3001, action: "accept" }, client);

    expect(client.writes().map((call) => [call.method, call.path, call.tier, call.body])).toEqual([
      ["PUT", "/Order/3001", "commit", { status: 500 }],
    ]);
    expect(plan.preview.action).toBe("Mark offer AN-1001 as accepted (sent 200 → accepted 500).");
    expect(plan.previewDe.action).toBe(
      "Angebot AN-1001 als angenommen markieren (versendet 200 → angenommen 500).",
    );
    expect(plan.preview.facts).toContainEqual({
      label: "Customer",
      value: "Musterfirma GmbH (contact 1001)",
    });
    expect(plan.preview.facts).toContainEqual({ label: "Gross", value: "171.38 EUR" });
    expect(plan.preview.irreversible).toBe(false);
    expect(plan.binding).toMatch(/^[0-9a-f]{64}$/);
    expect(output.data).toMatchObject({ order: { id: 3001, status: { code: 500 } } });
    expect(output.summary).toBe("Offer 3001 accepted: status Accepted (500).");
    expect(output.affected).toEqual([{ objectName: "Order", id: "3001" }]);
  });

  it("rejects a sent offer, and reopens a rejected or accepted one", async () => {
    const reject = staged(sentOffer, offer({ status: "300" }));
    const rejected = await executeWrite(tool, { id: 3001, action: "reject" }, reject);
    expect(reject.writes()[0]?.body).toEqual({ status: 300 });
    expect(rejected.plan.preview.action).toBe(
      "Mark offer AN-1001 as rejected (sent 200 → rejected 300).",
    );

    for (const from of ["300", "500"]) {
      const reopen = staged(offer({ status: from }), sentOffer);
      const reopened = await executeWrite(tool, { id: 3001, action: "reopen" }, reopen);
      expect(reopen.writes()[0]?.body).toEqual({ status: 200 });
      expect(reopened.output.summary).toBe("Offer 3001 reopened: status Delivered (sent) (200).");
      expect(reopened.plan.previewDe.action).toMatch(/^Angebot AN-1001 wieder öffnen \(/);
    }
  });

  it("says so when the offer reads back with another status", async () => {
    const client = staged(sentOffer, sentOffer);
    const { output } = await executeWrite(tool, { id: 3001, action: "accept" }, client);
    expect(output.summary).toBe(
      "sevDesk accepted the request, but offer 3001 reads back with status Delivered (sent) " +
        "(200) instead of 500. Check it with sevdesk_order_get before trying again.",
    );
  });

  it("refuses a draft offer before any request: sevDesk would renumber it", async () => {
    for (const action of ["accept", "reject", "reopen"]) {
      expect(await refusal(offer({ status: "100" }), action)).toBe(
        "Order 3001 is a draft offer that was never sent, so sevDesk would also renumber it on " +
          "a status change. Send it first (sevdesk_order_finalize, or sevdesk_order_send_email).",
      );
    }
  });

  it("refuses order confirmations and delivery notes", async () => {
    expect(await refusal(offer({ orderType: "AB" }), "accept")).toMatch(
      /^Order 3001 is an order confirmation \(Auftragsbestätigung, AB\); only offers \(AN\)/,
    );
    expect(await refusal(offer({ orderType: "LI" }), "reject")).toMatch(
      /^Order 3001 is a delivery note \(Lieferschein, LI\); only offers/,
    );
  });

  it("allows accept and reject only from sent, reopen only from accepted or rejected", async () => {
    expect(await refusal(offer({ status: "500" }), "accept")).toBe(
      "Order 3001 already has status 500, Accepted; there is nothing to change.",
    );
    expect(await refusal(offer({ status: "300" }), "accept")).toBe(
      'Order 3001 has status 300, Rejected / cancelled. Reopen it first (sevdesk_order_set_offer_status with action "reopen", back to sent 200), then accept it.',
    );
    expect(await refusal(offer({ status: "500" }), "reject")).toContain("Reopen it first");
    expect(await refusal(sentOffer, "reopen")).toBe(
      "Order 3001 already has status 200, Delivered (sent); there is nothing to change.",
    );
    expect(await refusal(offer({ status: "1000" }), "reopen")).toBe(
      "Order 3001 has status 1000, Calculated (invoiced); only accepted or rejected offers are reopened.",
    );
    expect(await refusal(offer({ status: "750" }), "reject")).toBe(
      "Order 3001 has status 750, Partially calculated (partially invoiced); only sent offers " +
        "(status 200) are rejected.",
    );
  });
});
