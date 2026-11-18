import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import type { CollectedList, SevdeskClient } from "../../../../src/sevdesk/types.js";
import { orderCreateConfirmationTool as tool } from "../../../../src/tools/orders/create-confirmation.js";
import type { FakeRoute } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  derivedReadRoutes,
  derivedRow,
  discountRow,
  discountsOf,
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

function failing(kind: SevdeskError["kind"]): { readonly error: SevdeskError } {
  return { error: new SevdeskError({ kind, message: `The request failed (${kind}).` }) };
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
  /** Discounts on the whole offer. */
  readonly discounts?: readonly Row[];
  /** Routes tried before the default ones, e.g. failing reads. */
  readonly beforeFirst?: readonly FakeRoute[];
  readonly afterFirst?: readonly FakeRoute[];
}

function staged(options: Options = {}): StagedClient {
  const readBack = options.readBack ?? created;
  return new StagedClient(
    [
      ...(options.beforeFirst ?? []),
      documentRoute("order", options.before ?? sentOffer),
      positionsOf("3001"),
      discountsOf("3001", options.discounts),
      list(options.earlier ?? []),
    ],
    [
      ...(options.afterFirst ?? []),
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

/** What the tool's execute throws after the one request it sends. */
async function executeFailure(client: SevdeskClient, staged: StagedClient): Promise<SevdeskError> {
  const error = await executeWrite(tool, { orderId: 3001 }, client).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SevdeskError);
  expect(staged.writes()).toHaveLength(1);
  return error as SevdeskError;
}

/** `client`, with the `GET /Order` scans whose query has `key` answered by `answer` instead. */
function scansBy(
  client: StagedClient,
  key: string,
  answer: (list: CollectedList) => CollectedList,
): SevdeskClient {
  return {
    request: (request) => client.request(request),
    list: (path, query, options) => client.list(path, query, options),
    listAll: async (path, query, options) => {
      const list = await client.listAll(path, query, options);
      return path === "/Order" && query?.[key] !== undefined ? answer(list) : list;
    },
    download: (request) => client.download(request),
  };
}

const cut = (list: CollectedList): CollectedList => ({ ...list, truncated: true });

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
      "Create an order confirmation (Auftragsbestätigung, AB) draft from offer 3001; sevDesk " +
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
      "Aus dem Angebot 3001 eine Auftragsbestätigung (AB) als Entwurf erstellen; sevDesk " +
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
      "Create an order confirmation (Auftragsbestätigung, AB) draft from offer 3001; the " +
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

  describe("after the request, a failure names what exists (review of #112, M1)", () => {
    const both = [
      { objectName: "Order", id: "3101" },
      { objectName: "Order", id: "3001" },
    ];

    it("names the accepted offer too when the confirmation cannot be read back", async () => {
      const client = staged({
        afterFirst: [{ path: "/Order/3101", response: failing("timeout") }],
      });
      const error = await executeFailure(client, client);
      expect(error.kind).toBe("timeout");
      expect(error.completedWrites).toEqual(both);
    });

    it("names the offer when the answer carries no readable id", async () => {
      const client = staged({ answer: { unexpected: true } });
      const error = await executeFailure(client, client);
      expect(error.kind).toBe("unexpected_response");
      expect(error.completedWrites).toEqual([{ objectName: "Order", id: "3001" }]);
    });

    it("names the confirmation and the offer when cancelled during the number check", async () => {
      const client = staged({
        afterFirst: [
          { path: "/Order", query: { orderNumber: "AB-1003" }, response: failing("aborted") },
        ],
      });
      const error = await executeFailure(client, client);
      expect(error.kind).toBe("aborted");
      expect(error.completedWrites).toEqual(both);
    });

    it("names them when the number check fails unexpectedly", async () => {
      const client = staged();
      const broken = scansBy(client, "orderNumber", () => {
        throw new TypeError("broken");
      });
      const error = await executeFailure(broken, client);
      expect(error.kind).toBe("unexpected_response");
      expect(error.message).toBe(
        "The order confirmation was created, but checking its number against other orders " +
          "failed unexpectedly.",
      );
      expect(error.completedWrites).toEqual(both);
    });
  });

  describe("notes and warnings of the checks around the request (review of #112, L4)", () => {
    const counter =
      "sevDesk does not move its AB number counter for this request, so the next order " +
      "confirmation may get AB-1003 again; check the number before sending either.";

    it("notes a number check that failed, without failing the call", async () => {
      const client = staged({
        afterFirst: [
          { path: "/Order", query: { orderNumber: "AB-1003" }, response: failing("server") },
        ],
      });
      const { output } = await executeWrite(tool, { orderId: 3001 }, client);
      expect(output.data.notes).toEqual([
        counter,
        "Whether another order confirmation carries AB-1003 already could not be checked; look " +
          "it up with sevdesk_orders_list.",
      ]);
    });

    it("notes a number check cut at its cap", async () => {
      const client = scansBy(staged(), "orderNumber", cut);
      const { output } = await executeWrite(tool, { orderId: 3001 }, client);
      expect(output.data.notes).toEqual([
        counter,
        "Not every order confirmation could be checked for the same number; look it up with " +
          "sevdesk_orders_list.",
      ]);
    });

    it("notes a confirmation without a number and skips the number check", async () => {
      const client = staged({ readBack: { ...created, orderNumber: null } });
      const { output } = await executeWrite(tool, { orderId: 3001 }, client);
      expect(output.data.notes).toEqual([
        "sevDesk gave the new order confirmation no number; set one before sending it.",
      ]);
      expect(client.calls.filter((call) => call.query["orderNumber"] !== undefined)).toEqual([]);
    });

    it("notes an offer that could not be read again and lists it as affected", async () => {
      const client = staged({ afterFirst: [{ path: "/Order/3001", response: failing("server") }] });
      const { output } = await executeWrite(tool, { orderId: 3001 }, client);
      expect(output.data.notes?.[0]).toBe(
        "Offer 3001 could not be read again; check its status with sevdesk_order_get.",
      );
      expect(output.affected).toEqual([
        { objectName: "Order", id: "3101" },
        { objectName: "Order", id: "3001" },
      ]);
      expect(output.summary).toBe(
        "Created order confirmation draft 3101 from offer 3001. Finalize it with " +
          "sevdesk_order_finalize.",
      );
    });

    it("warns in both languages when the earlier-confirmation scan was cut", async () => {
      const plan = await prepareWrite(tool, { orderId: 3001 }, scansBy(staged(), "orderType", cut));
      expect(plan.preview.warnings).toContain(
        "Not every order could be checked for an earlier confirmation from this offer.",
      );
      expect(plan.previewDe.warnings).toContain(
        "Nicht alle Aufträge konnten auf eine frühere Auftragsbestätigung aus diesem Angebot " +
          "geprüft werden.",
      );
    });

    it("scans without a contact filter when the offer has no contact", async () => {
      const client = staged({ before: offer({ contact: null }) });
      await prepareWrite(tool, { orderId: 3001 }, client);
      const scans = client.calls.filter((call) => call.path === "/Order");
      expect(scans).toHaveLength(1);
      expect(scans[0]?.query).toMatchObject({ orderType: "AB" });
      expect(scans[0]?.query).not.toHaveProperty("contact[id]");
    });
  });

  it("shows and binds the offer's document discounts in both languages (review of #112, L5)", async () => {
    const client = staged({
      discounts: [
        discountRow("3001"),
        discountRow("3001", {
          id: "8002",
          discount: "0",
          text: "Expresszuschlag",
          percentage: "0",
          value: "12.5",
          isNet: "0",
        }),
      ],
    });
    const plan = await prepareWrite(tool, { orderId: 3001 }, client);
    // Read once, with the approval content (D-116), not a second time for the preview.
    const reads = client.calls.filter((call) => call.path === "/Order/3001/getDiscounts");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.query).toEqual(expect.objectContaining({ limit: 1000 }));
    expect(plan.preview.facts).toEqual(
      expect.arrayContaining([
        {
          label: "Discount on the whole document (Rabatt) 1",
          value: "5 % of the net total\nText: Treuerabatt",
        },
        {
          label: "Discount on the whole document (Rabatt) 2",
          value: "surcharge (Aufschlag): 12.50 EUR gross\nText: Expresszuschlag",
        },
      ]),
    );
    expect(plan.previewDe.facts).toEqual(
      expect.arrayContaining([
        { label: "Rabatt auf den Gesamtbetrag 1", value: "5 % vom Nettobetrag\nText: Treuerabatt" },
        {
          label: "Rabatt auf den Gesamtbetrag 2",
          value: "Aufschlag: 12,50 EUR brutto\nText: Expresszuschlag",
        },
      ]),
    );
    // Two rows: sevDesk's totals may count only one of them.
    expect(plan.preview.warnings.join("\n")).toContain(
      "This document has 2 discounts on the whole document",
    );
    expect(plan.previewDe.warnings.join("\n")).toContain(
      "Das Dokument hat 2 Rabatte auf den Gesamtbetrag",
    );
    expect(plan.preview.warnings).toContain(
      "The offer carries discounts or surcharges on the whole document (listed above). Whether " +
        "sevDesk takes them over to the order confirmation has not been checked; compare the " +
        "new draft's totals with sevdesk_order_get before finalizing it.",
    );
    expect(plan.previewDe.warnings).toContain(
      "Das Angebot trägt Rabatte oder Aufschläge auf das ganze Dokument (oben aufgeführt). Ob " +
        "sevDesk sie in die Auftragsbestätigung übernimmt, ist nicht geprüft; vergleiche die " +
        "Summen des neuen Entwurfs mit sevdesk_order_get, bevor du ihn fertigstellst.",
    );
    // Without discounts there is neither the fact nor the warning, and the approval is bound to
    // the rows: a discount added after the human was asked asks again.
    const plain = await prepareWrite(tool, { orderId: 3001 }, staged());
    expect(plain.preview.facts.map((fact) => fact.label)).not.toContain(
      "Discount on the whole document (Rabatt)",
    );
    expect(plain.preview.warnings.join("\n")).not.toContain("discounts or surcharges");
    expect(plain.binding).not.toBe(plan.binding);
  });

  it("refuses when sevDesk lists another order's discount for the offer (D-116)", async () => {
    // Nothing is approved on discount rows that could not be read cleanly.
    const client = staged({
      discounts: [
        discountRow("3001"),
        discountRow("3001", { id: "8003", object: { id: "3009", objectName: "Order" } }),
      ],
    });
    const error = await prepareWrite(tool, { orderId: 3001 }, client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("unexpected_response");
    expect(client.writes()).toEqual([]);
  });
});
