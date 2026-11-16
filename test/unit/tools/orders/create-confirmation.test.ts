import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { orderCreateConfirmationTool as tool } from "../../../../src/tools/orders/create-confirmation.js";
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  derivedReadRoutes,
  derivedRow,
  positionsOf,
  sentOffer,
} from "../../../write-cases/orders.js";
import { documentRoute, positionRoutes, type Row, StagedClient } from "../lifecycle/helpers.js";

const CREATE = "/Order/Factory/createContractNoteFromOrder";
const offer = (overrides: Row): Row => ({ ...sentOffer, ...overrides });
const created = derivedRow("3101", "AB", "AB-1003", "3001");

function list(rows: readonly Row[]): FakeRoute {
  return { path: "/Order", response: { body: { objects: rows } } };
}

interface Options {
  readonly before?: Row;
  readonly afterOffer?: Row;
  readonly answer?: unknown;
  readonly readBack?: Row;
  /** Orders the scan before the request finds. */
  readonly earlier?: readonly Row[];
  /** Orders the number scan after the request finds. */
  readonly sameNumber?: readonly Row[];
}

function staged(options: Options = {}): StagedClient {
  const readBack = options.readBack ?? created;
  return new StagedClient(
    [
      documentRoute("order", options.before ?? sentOffer),
      positionsOf("3001"),
      list(options.earlier ?? []),
    ],
    [
      {
        method: "POST",
        path: CREATE,
        response: { body: { objects: options.answer ?? readBack } },
      },
      list(options.sameNumber ?? []),
      ...derivedReadRoutes(readBack),
      documentRoute("order", options.afterOffer ?? offer({ status: "500" })),
      ...positionRoutes(),
    ],
  );
}

async function refusal(before: Row, earlier: readonly Row[] = []): Promise<string> {
  const client = staged({ before, earlier });
  const error = await prepareWrite(tool, { orderId: 3001 }, client).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  expect(client.writes()).toEqual([]);
  return (error as SevdeskError).message;
}

describe("sevdesk_order_create_confirmation (D-107)", () => {
  it("is a commit tool of the orders toolset that locks the offer", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.toolset).toBe("orders");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tool.locks?.(tool.input.parse({ orderId: 3001 }))).toEqual([
      { objectName: "Order", id: "3001" },
    ]);
  });

  it("previews the offer, its positions and that it becomes accepted", async () => {
    const client = staged();
    const plan = await prepareWrite(tool, { orderId: 3001 }, client);
    expect(client.writes()).toEqual([]);
    expect(plan.preview.action).toBe(
      "Create an order confirmation (Auftragsbestätigung, AB) draft from offer AN-1001; sevDesk " +
        "marks the offer as accepted (sent 200 → accepted 500).",
    );
    expect(plan.preview.facts).toEqual(
      expect.arrayContaining([
        { label: "Order (Auftrag)", value: "AN-1001 (id 3001)" },
        { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
        { label: "Gross", value: "171.38 EUR" },
        { label: "Creates", value: "order confirmation (Auftragsbestätigung, AB) as a draft" },
        expect.objectContaining({ label: "Position 1" }) as unknown,
        expect.objectContaining({ label: "Position 2" }) as unknown,
      ]),
    );
    expect(plan.preview.warnings[0]).toBe(
      "sevDesk marks the offer as accepted (status 500) in the same request: that is the " +
        "binding step of this action. If that was not meant, set the offer back with " +
        'sevdesk_order_set_offer_status (action "reopen").',
    );
    expect(plan.previewDe.action).toBe(
      "Aus dem Angebot AN-1001 eine Auftragsbestätigung (AB) als Entwurf erstellen; sevDesk " +
        "markiert das Angebot dabei als angenommen (versendet 200 → angenommen 500).",
    );
    expect(plan.binding).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.preview.irreversible).toBe(false);
  });

  it("creates the confirmation with the offer in query and body, and reads both back", async () => {
    const client = staged();
    const { output } = await executeWrite(tool, { orderId: 3001 }, client);
    expect(
      client.writes().map((call) => [call.method, call.path, call.tier, call.query, call.body]),
    ).toEqual([
      [
        "POST",
        CREATE,
        "commit",
        { "order[id]": 3001, "order[objectName]": "Order" },
        { id: 3001, objectName: "Order" },
      ],
    ]);
    expect(output.data.order).toMatchObject({
      id: 3101,
      number: "AB-1003",
      status: { code: 100 },
      type: { code: "AB" },
      origin: { objectName: "Order", id: 3001 },
    });
    expect(output.data.sourceOrderId).toBe(3001);
    expect(output.data.sourceOrderStatus).toMatchObject({ code: 500 });
    expect(output.data.notes).toEqual([
      "sevDesk does not move its AB number counter for this request, so the next order " +
        "confirmation may get AB-1003 again; check the number before sending either.",
    ]);
    expect(output.affected).toEqual([
      { objectName: "Order", id: "3101" },
      { objectName: "Order", id: "3001" },
    ]);
    expect(output.summary).toBe(
      "Created order confirmation draft 3101 from offer 3001; the offer has status 500. " +
        "Finalize it with sevdesk_order_finalize.",
    );
  });

  it("creates one from an accepted offer and says the offer stays accepted", async () => {
    const accepted = offer({ status: "500" });
    const client = staged({ before: accepted, afterOffer: accepted });
    const { plan, output } = await executeWrite(tool, { orderId: 3001 }, client);
    expect(plan.preview.action).toBe(
      "Create an order confirmation (Auftragsbestätigung, AB) draft from offer AN-1001; the " +
        "offer stays accepted (500).",
    );
    expect(plan.preview.warnings[0]).toBe(
      "The offer is accepted already (status 500) and stays so.",
    );
    expect(plan.previewDe.warnings[0]).toBe(
      "Das Angebot ist bereits angenommen (Status 500) und bleibt es.",
    );
    // The offer read back unchanged, so only the confirmation is affected.
    expect(output.affected).toEqual([{ objectName: "Order", id: "3101" }]);
  });

  it("refuses a draft offer before any request (sevDesk would accept it unsent)", async () => {
    expect(await refusal(offer({ status: "100" }))).toBe(
      "Order 3001 is a draft offer that was never sent, so a confirmation would accept an offer " +
        "the customer never received. Send it first (sevdesk_order_finalize, or " +
        "sevdesk_order_send_email).",
    );
  });

  it("refuses a rejected offer before any request (sevDesk would accept it silently)", async () => {
    expect(await refusal(offer({ status: "300" }))).toBe(
      "Order 3001 was rejected (status 300), and sevDesk would silently mark it as accepted " +
        "when a confirmation is created from it. If the customer accepted after all, reopen it " +
        'first (sevdesk_order_set_offer_status with action "reopen", back to sent 200), then ' +
        "create the confirmation.",
    );
  });

  it("refuses other types and statuses", async () => {
    expect(await refusal(offer({ orderType: "AB" }))).toBe(
      "Order 3001 is an order confirmation (Auftragsbestätigung, AB); order confirmations are " +
        "created from offers (AN) only.",
    );
    expect(await refusal(offer({ orderType: "LI" }))).toMatch(/is a delivery note/);
    expect(await refusal(offer({ status: "1000" }))).toBe(
      "Order 3001 has status 1000, Calculated (invoiced); order confirmations are created from " +
        "sent (200) or accepted (500) offers only.",
    );
  });

  it("refuses when a confirmation from the offer exists, unless allowDuplicate", async () => {
    const earlier = [
      derivedRow("3050", "AB", "AB-1001", "3001"),
      // Not from this offer, or not a confirmation: ignored.
      derivedRow("3051", "AB", "AB-1002", "3009"),
      derivedRow("3052", "LI", "LI-1001", "3001"),
    ];
    expect(await refusal(sentOffer, earlier)).toBe(
      "An order confirmation from order 3001 exists already: order 3050. Check it with " +
        "sevdesk_order_get, or call again with allowDuplicate: true to create another one.",
    );
    const plan = await prepareWrite(
      tool,
      { orderId: 3001, allowDuplicate: true },
      staged({ earlier }),
    );
    expect(plan.preview.warnings).toContain(
      "Creating another one (allowDuplicate): order 3050 was created from this offer already.",
    );
    expect(plan.previewDe.warnings).toContain(
      "Es wird trotzdem eine weitere erstellt (allowDuplicate): Aus diesem Angebot wurde " +
        "bereits Auftrag 3050 erstellt.",
    );
  });

  it("names another confirmation with the same number", async () => {
    const client = staged({ sameNumber: [derivedRow("2990", "AB", "AB-1003", "2900")] });
    const { output } = await executeWrite(tool, { orderId: 3001 }, client);
    expect(output.data.notes?.[0]).toBe(
      "The new order confirmation has the same number (AB-1003) as order 2990: sevDesk hands " +
        "out the next number of the range without moving its counter. Give one of them another " +
        "number in the sevDesk web app before sending it.",
    );
  });

  it("says so when sevDesk did not accept the offer", async () => {
    const client = staged({ afterOffer: sentOffer });
    const { output } = await executeWrite(tool, { orderId: 3001 }, client);
    expect(output.data.notes?.[0]).toBe(
      "sevDesk did not mark offer 3001 as accepted: it has status 200. Check it with " +
        "sevdesk_order_get.",
    );
  });

  it("refuses to claim a draft when the new order is not one, of another type or source", async () => {
    for (const [patch, problem] of [
      [{ status: "200" }, "its status is 200, not 100 (draft)"],
      [{ orderType: "LI" }, "it has type LI instead of AB"],
      [{ origin: null }, "it does not point to the order it was created from"],
    ] as const) {
      const client = staged({ readBack: { ...created, ...patch } });
      await expect(executeWrite(tool, { orderId: 3001 }, client)).rejects.toMatchObject({
        kind: "unexpected_response",
        message: expect.stringContaining(problem) as string,
        completedWrites: expect.arrayContaining([{ objectName: "Order", id: "3101" }]) as unknown,
      });
    }
  });

  it("does not take the source for the new order when the answer names it", async () => {
    const client = staged({ answer: sentOffer });
    await expect(executeWrite(tool, { orderId: 3001 }, client)).rejects.toMatchObject({
      kind: "unexpected_response",
      completedWrites: [{ objectName: "Order", id: "3001" }],
    });
    expect(client.writes()).toHaveLength(1);
  });
});
