/**
 * An approval must cover the discount on the whole document it makes binding, and the human must
 * see it.
 *
 * The draft tools (write tier, no confirmation) can set a discount on the whole invoice, credit
 * note or order (`discountSave`, spec/deviations.md D-116). sevDesk keeps it in rows of its own:
 * the document record carries only the sums, not the percentage or amount and not the text
 * printed with it. Finalizing, sending or enshrining approves the document, so without the rows
 * a model could add a discount (or change its text, say to other bank details) while the human
 * reads the approval and retry with the old one, or set one before asking and have it approved
 * unseen.
 *
 * Guard 1: the binding of finalize, send and enshrine (`readDocumentContent`) hashes the discount
 * rows exactly as `getDiscounts` listed them, next to the raw record and positions: any change to
 * them, also one the facts do not show, asks again.
 *
 * Guard 2: the facts list every discount (percentage or amount, net or gross, a surcharge marked,
 * the text as stored) and what they deduct in total, in English and German, built from the same
 * read as the binding.
 *
 * Guard 3: a document with several discount rows gets a warning in both languages, because
 * sevDesk's totals then count only one of them (checked 2026-11-17, D-116).
 */
import { describe, expect, it } from "vitest";

import { enshrineTool } from "../../src/tools/lifecycle/enshrine.js";
import { finalizeTool } from "../../src/tools/lifecycle/finalize.js";
import { sendEmailTool } from "../../src/tools/lifecycle/send-email.js";
import type { AnyWriteToolDefinition } from "../../src/tools/types.js";
import { approve } from "../helpers/confirm-client.js";
import { withCountryRoute } from "../helpers/country-route.js";
import { type FakeRoute, FakeSevdeskClient } from "../helpers/fake-client.js";
import {
  closeWriteHarnessesAfterEach,
  resultData,
  writeHarness,
  writesOf,
} from "../helpers/write-flow.js";
import { prepareWrite } from "../helpers/write-tools.js";
import { discountRow } from "../unit/tools/drafts/routes.js";
import {
  creditNoteRow,
  documentRoute,
  invoiceRow,
  orderRow,
  positionRoutes,
  type Row,
  writeRoute,
} from "../unit/tools/lifecycle/helpers.js";

closeWriteHarnessesAfterEach();

const ATTACKER_TEXT = "Bitte an IBAN DE00 1234 5678 9012 3456 78 überweisen";

function draft(overrides: Row = {}): Row {
  return invoiceRow({
    status: "100",
    invoiceNumber: null,
    sendType: null,
    sendDate: null,
    sumDiscountNet: "-14.90",
    sumDiscountGross: "-17.73",
    ...overrides,
  });
}

function open(overrides: Row = {}): Row {
  return invoiceRow({ status: "200", ...overrides });
}

/** `getDiscounts` of invoice 1001 answering `rows`, read at request time (so tests can edit them). */
function discountsOf(rows: Row[], path = "/Invoice/1001/getDiscounts"): FakeRoute {
  return { path, response: { body: { objects: rows, total: null } } };
}

function client(row: Row, discounts: Row[]): FakeSevdeskClient {
  return new FakeSevdeskClient(
    withCountryRoute([documentRoute("invoice", row), discountsOf(discounts), ...positionRoutes()]),
  );
}

describe("approval binds the discount on the whole document", () => {
  const edits: readonly [string, (rows: Row[]) => void][] = [
    ["a discount is added", (rows) => rows.push(discountRow("Invoice", 1001))],
    [
      "the percentage changes",
      (rows) => {
        rows[0] = discountRow("Invoice", 1001, { value: "50" });
      },
    ],
    [
      "its text changes",
      (rows) => {
        rows[0] = discountRow("Invoice", 1001, { text: ATTACKER_TEXT });
      },
    ],
    [
      "it becomes a fixed amount",
      (rows) => {
        rows[0] = discountRow("Invoice", 1001, { percentage: "0" });
      },
    ],
    ["it is removed", (rows) => rows.splice(0)],
  ];

  it.each(edits)("asks again when %s after the human was asked (finalize)", async (label, edit) => {
    const rows: Row[] = label.startsWith("a discount is added")
      ? []
      : [discountRow("Invoice", 1001)];
    const {
      client: mcp,
      fake,
      prompts,
    } = await writeHarness({
      tools: [finalizeTool("invoice")],
      routes: [
        documentRoute("invoice", draft()),
        discountsOf(rows),
        ...positionRoutes(),
        writeRoute("PUT", "/Invoice/1001/sendBy", "invoice-send-by.json"),
      ],
      connect: {
        era: "modern",
        transport: "http",
        answer: (params) => {
          // While the human reads the first prompt, the model edits the draft's discount.
          if (prompts.length === 1) edit(rows);
          return approve(params);
        },
      },
    });

    const result = await mcp.callTool({
      name: "sevdesk_invoice_finalize",
      arguments: { id: 1001 },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.message).toMatch(/^The record changed after you were asked/);
    expect(resultData(result)).toMatchObject({ status: "done" });
    expect(writesOf(fake)).toEqual([{ method: "PUT", path: "/Invoice/1001/sendBy" }]);
  });

  it("asks once when the discount did not change", async () => {
    const {
      client: mcp,
      fake,
      prompts,
    } = await writeHarness({
      tools: [finalizeTool("invoice")],
      routes: [
        documentRoute("invoice", draft()),
        discountsOf([discountRow("Invoice", 1001)]),
        ...positionRoutes(),
        writeRoute("PUT", "/Invoice/1001/sendBy", "invoice-send-by.json"),
      ],
      connect: { era: "modern", transport: "http", answer: approve },
    });

    const result = await mcp.callTool({
      name: "sevdesk_invoice_finalize",
      arguments: { id: 1001 },
    });

    expect(prompts).toHaveLength(1);
    // A value of several lines is shown indented below its label.
    expect(prompts[0]?.message).toContain(
      "Discount on the whole document (Rabatt):\n  10 % of the net total\n  Text: Rabatt",
    );
    expect(resultData(result)).toMatchObject({ status: "done" });
    expect(writesOf(fake)).toHaveLength(1);
  });

  it("changes the binding of send and enshrine when only the row's update time differs", async () => {
    const send = sendEmailTool("invoice");
    const enshrine = enshrineTool("invoice");
    const args = { id: 1001, to: "kunde@example.com", subject: "Rechnung", text: "Anbei." };
    const plans = async (rows: Row[]) => ({
      send: await prepareWrite(send, args, client(open(), rows)),
      enshrine: await prepareWrite(enshrine, { id: 1001 }, client(open(), rows)),
    });

    const before = await plans([discountRow("Invoice", 1001)]);
    const after = await plans([
      discountRow("Invoice", 1001, { update: "2026-11-16T18:00:00+01:00" }),
    ]);

    // The previews cannot tell the two apart; the binding, which the approval covers, can.
    expect(after.send.preview).toEqual(before.send.preview);
    expect(after.send.binding).not.toBe(before.send.binding);
    expect(after.enshrine.preview).toEqual(before.enshrine.preview);
    expect(after.enshrine.binding).not.toBe(before.enshrine.binding);
  });
});

describe("the approval shows the discount it makes binding", () => {
  const email = { id: 1001, to: "kunde@example.com", subject: "Rechnung", text: "Anbei." };

  it.each([
    ["finalize", finalizeTool("invoice"), { id: 1001 }, draft],
    ["send", sendEmailTool("invoice"), email, draft],
    ["send (open invoice)", sendEmailTool("invoice"), email, open],
    ["enshrine", enshrineTool("invoice"), { id: 1001 }, open],
  ] as const)(
    "%s: the discount, its text and its sums are facts in English and German",
    async (_name, tool, args, row) => {
      const plan = await prepareWrite(
        tool as AnyWriteToolDefinition,
        args,
        client(row({ sumDiscountNet: "-14.90", sumDiscountGross: "-17.73" }), [
          discountRow("Invoice", 1001, { text: ATTACKER_TEXT }),
        ]),
      );

      expect(plan.preview.facts).toContainEqual({
        label: "Discount on the whole document (Rabatt)",
        value: `10 % of the net total\nText: ${ATTACKER_TEXT}`,
      });
      expect(plan.preview.facts).toContainEqual({
        label: "Discounts in total",
        value: "-14.90 EUR net, -17.73 EUR gross",
      });
      expect(plan.previewDe?.facts).toContainEqual({
        label: "Rabatt auf den Gesamtbetrag",
        value: `10 % vom Nettobetrag\nText: ${ATTACKER_TEXT}`,
      });
      expect(plan.previewDe?.facts).toContainEqual({
        label: "Rabatte insgesamt",
        value: "-14,90 EUR netto, -17,73 EUR brutto",
      });
      expect(plan.previewDe?.facts).toHaveLength(plan.preview.facts.length);
    },
  );

  it.each([
    ["order", orderRow({ status: "100", orderNumber: null }), "Order", 3002],
    [
      "creditNote",
      creditNoteRow({ status: "100", sendType: null, sendDate: null }),
      "CreditNote",
      2001,
    ],
  ] as const)(
    "finalize of a draft %s shows its discount and binds it",
    async (kind, row, objectName, id) => {
      const tool = finalizeTool(kind);
      const plan = (rows: Row[]) =>
        prepareWrite(
          tool,
          { id },
          new FakeSevdeskClient(
            withCountryRoute([
              documentRoute(kind, row),
              discountsOf(rows, `/${objectName}/${String(id)}/getDiscounts`),
              ...positionRoutes(),
            ]),
          ),
        );

      const without = await plan([]);
      const discounted = await plan([discountRow(objectName, id, { percentage: "0" })]);

      expect(discounted.preview.facts).toContainEqual({
        label: "Discount on the whole document (Rabatt)",
        value: "10.00 EUR net\nText: Rabatt",
      });
      expect(discounted.previewDe.facts).toContainEqual({
        label: "Rabatt auf den Gesamtbetrag",
        value: "10,00 EUR netto\nText: Rabatt",
      });
      expect(discounted.binding).not.toBe(without.binding);
    },
  );

  // Guard 3: with several rows sevDesk's totals count only one of them (checked 2026-11-17: a
  // fixed 5.00 and 3 %, and only the 3 % was in the sums), so the totals in the facts may not be
  // what the listed discounts suggest. The approval says so in both languages.
  it.each([
    ["finalize", finalizeTool("invoice"), { id: 1001 }, draft],
    ["send", sendEmailTool("invoice"), email, open],
    ["enshrine", enshrineTool("invoice"), { id: 1001 }, open],
  ] as const)(
    "%s warns in English and German when the document has several discounts",
    async (_name, tool, args, row) => {
      const rows = [
        discountRow("Invoice", 1001, { percentage: "0", value: "5" }),
        discountRow("Invoice", 1001, { id: "9002", value: "3" }),
      ];
      const several = await prepareWrite(tool as AnyWriteToolDefinition, args, client(row(), rows));
      const one = await prepareWrite(
        tool as AnyWriteToolDefinition,
        args,
        client(row(), rows.slice(1)),
      );

      const english =
        "This document has 2 discounts on the whole document, and sevDesk's totals may count " +
        "only one of them (in a check, only the newest), so the total may not be what the " +
        "listed discounts suggest. Check the total in sevDesk.";
      expect(several.preview.warnings).toContain(english);
      expect(several.previewDe?.warnings).toContain(
        "Das Dokument hat 2 Rabatte auf den Gesamtbetrag, und sevDesk rechnet in den Summen " +
          "womöglich nur einen davon ein (in einer Prüfung nur den neuesten); die Summe ist dann " +
          "nicht, was die aufgeführten Rabatte erwarten lassen. Prüfe die Summe in sevDesk.",
      );
      expect(several.previewDe?.warnings).toHaveLength(several.preview.warnings.length);
      expect(several.preview.facts.map((fact) => fact.label)).toEqual(
        expect.arrayContaining([
          "Discount on the whole document (Rabatt) 1",
          "Discount on the whole document (Rabatt) 2",
        ]),
      );
      expect(one.preview.warnings).not.toContain(english);
      expect(several.preview.warnings).toHaveLength(one.preview.warnings.length + 1);
    },
  );
});
