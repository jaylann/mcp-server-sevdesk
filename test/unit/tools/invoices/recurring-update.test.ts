import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { invoiceUpdateRecurringTool as tool } from "../../../../src/tools/invoices/recurring-update.js";
import { ACCOUNT_RECURRING_INVOICES } from "../../../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { TIMESTAMPS, unknownRegimeRoute, withRoutes } from "../drafts/routes.js";
import { StagedClient } from "../lifecycle/helpers.js";
import {
  type Row,
  storedDate,
  templateChangeRoutes,
  templatePositionRows,
  templateRoutes,
  templateRow,
} from "./recurring-manage-routes.js";

/** Berlin midnight of 2027-01-01 (winter time) and 2027-06-01 (summer time) in Unix seconds. */
const JAN_1 = TIMESTAMPS["2026-11-30"] + 32 * 86_400;
const JUN_1 = Date.UTC(2027, 4, 31, 22) / 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-17T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

async function prepare(
  callArgs: Record<string, unknown>,
  table: readonly FakeRoute[] = templateChangeRoutes(),
) {
  const client = new FakeSevdeskClient(table);
  const plan = await prepareWrite(tool, { id: 2301, ...callArgs }, client);
  expect(client.writes()).toEqual([]);
  return plan;
}

async function refusal(
  callArgs: Record<string, unknown>,
  table: readonly FakeRoute[] = templateChangeRoutes(),
) {
  const client = new FakeSevdeskClient(table);
  const error = await prepareWrite(tool, { id: 2301, ...callArgs }, client).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  expect(client.writes()).toEqual([]);
  return (error as SevdeskError).message;
}

const fact = (facts: readonly { label: string; value: string }[], label: string) =>
  facts.find((f) => f.label === label)?.value;

const head = { id: 2301, objectName: "Invoice", mapAll: true };

describe("sevdesk_invoice_update_recurring", () => {
  it("is a commit tool: destructive, idempotent, closed world, locked per account and template", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.toolset).toBe("invoices");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool.locks?.(tool.input.parse({ id: 2301, header: "Neu" }))).toEqual([
      ACCOUNT_RECURRING_INVOICES,
      { objectName: "Invoice", id: "2301" },
    ]);
  });

  describe("sends only what changes (D-111, D-112)", () => {
    it("a new interval: accountIntervall alone, the next run stays", async () => {
      const plan = await prepare({ interval: "quarterly" });
      expect(plan.state.body).toEqual({
        invoice: { ...head, accountIntervall: "P0Y3M0W" },
        invoicePosSave: null,
        invoicePosDelete: null,
      });
      expect(plan.state.schedule).toEqual({
        interval: "P0Y3M0W",
        startDate: "2026-12-01",
        nextRun: "2026-12-01",
        endDate: undefined,
      });
      expect(plan.preview.action).toBe(
        "Change recurring invoice template 2301 (Abo-Rechnung) for Musterfirma GmbH (contact " +
          "1001): interval.",
      );
      expect(plan.preview.facts).toEqual([
        { label: "Template", value: "2301 (recurring invoice template, active)" },
        { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
        {
          label: "Interval",
          value: "monthly (P0Y1M0W) → quarterly, every 3 months on day 1 (P0Y3M0W)",
        },
        { label: "Next run", value: "2026-12-01" },
        { label: "Following runs", value: "2027-03-01, 2027-06-01, 2027-09-01" },
        {
          label: "End",
          value: "none (sevDesk keeps creating invoices until the template is ended)",
        },
        { label: "Total per invoice", value: "unchanged: gross 65.45 EUR" },
      ]);
      expect(plan.preview.warnings).toEqual([
        "Every invoice sevDesk creates from this template after the change carries it, by " +
          "itself and without asking anyone again. This approval covers all of them until the " +
          "template ends.",
        "Invoices sevDesk already created from this template stay as they are; the change " +
          "applies only to later ones.",
        expect.stringMatching(/^Not recorded yet: what sevDesk generates on a run date/),
        "With a new interval sevDesk keeps the next run (2026-12-01); the runs after it follow " +
          "the new interval.",
      ]);
    });

    it("says the same in German, in the same order", async () => {
      const plan = await prepare({ interval: "quarterly", endDate: "2027-06-01" });
      expect(plan.previewDe.action).toBe(
        "Abo-Rechnung 2301 für Musterfirma GmbH (Kontakt 1001) ändern: Intervall, Enddatum.",
      );
      expect(plan.previewDe.facts.map((f) => f.label)).toEqual([
        "Vorlage",
        "Kunde",
        "Intervall",
        "Enddatum",
        "Nächste Ausführung",
        "Folgende Ausführungen",
        "Ende",
        "Summe je Rechnung",
      ]);
      expect(fact(plan.previewDe.facts, "Intervall")).toBe(
        "monatlich (P0Y1M0W) → vierteljährlich, alle 3 Monate am 1. (P0Y3M0W)",
      );
      expect(fact(plan.previewDe.facts, "Enddatum")).toBe("keines → 01.06.2027");
      expect(fact(plan.previewDe.facts, "Ende")).toBe(
        "01.06.2027 (bis dahin 3 Rechnungen, die erste eingeschlossen)",
      );
      expect(plan.previewDe.warnings).toHaveLength(plan.preview.warnings.length);
      expect(plan.state.body.invoice.accountEndDate).toBe(JUN_1);
    });

    it("an end date alone, and null to remove one", async () => {
      const end = await prepare({ endDate: "2027-06-01" });
      expect(end.state.body.invoice).toEqual({ ...head, accountEndDate: JUN_1 });
      const withEnd = templateChangeRoutes(
        templateRow({ accountEndDate: storedDate("2027-06-01") }),
      );
      const removed = await prepare({ removeEndDate: true }, withEnd);
      expect(removed.state.body.invoice).toEqual({ ...head, accountEndDate: null });
      expect(fact(removed.preview.facts, "End date")).toBe("2027-06-01 → none");
      expect(removed.state.schedule.endDate).toBeUndefined();
    });

    it("a new start date moves the next run too", async () => {
      const plan = await prepare({ startDate: "2027-01-01" });
      expect(plan.state.body.invoice).toEqual({ ...head, accountStartDate: JAN_1 });
      expect(plan.state.schedule).toMatchObject({ startDate: "2027-01-01", nextRun: "2027-01-01" });
      expect(fact(plan.preview.facts, "Start date")).toBe(
        "2026-12-01 → 2027-01-01 (also the next run)",
      );
      expect(plan.preview.warnings).toContain(
        "sevDesk moves the next run to the new start date as well.",
      );
    });

    it("texts and the title, and nothing for a value that is already stored", async () => {
      const plan = await prepare({
        header: "Wartungsvertrag",
        footText: "Zahlbar ohne Abzug.",
        headText: undefined,
        timeToPay: 14,
      });
      expect(plan.state.body.invoice).toEqual({
        ...head,
        header: "Wartungsvertrag",
        footText: "Zahlbar ohne Abzug.",
        timeToPay: 14,
      });
      expect(fact(plan.preview.facts, "Title (Betreff)")).toBe("Rechnung → Wartungsvertrag");
      expect(fact(plan.preview.facts, "Foot text (Fußtext), new")).toBe("Zahlbar ohne Abzug.");
      expect(fact(plan.preview.facts, "Payment term (Zahlungsziel)")).toBe("none → 14 days");
      const same = await prepare({ header: "Rechnung", footText: "Neu" });
      expect(same.state.body.invoice).toEqual({ ...head, footText: "Neu" });
    });

    it("positions replace every stored one in one request, never by id", async () => {
      const plan = await prepare({
        positions: [{ name: "Wartung", quantity: 1, unitPrice: "200.00", taxRate: 19 }],
      });
      expect(plan.state.body).toEqual({
        invoice: head,
        invoicePosSave: [
          {
            objectName: "InvoicePos",
            mapAll: true,
            quantity: 1,
            price: "200.00",
            name: "Wartung",
            unity: { id: 1, objectName: "Unity" },
            taxRate: 19,
            positionNumber: 0,
          },
        ],
        invoicePosDelete: [
          { id: 5301, objectName: "InvoicePos" },
          { id: 5302, objectName: "InvoicePos" },
        ],
      });
      expect(fact(plan.preview.facts, "Positions")).toBe("replace 2 positions with 1 position");
      expect(fact(plan.preview.facts, "Position 1")).toBe(
        "Wartung: 1 × 200.00 EUR net, 19 % VAT → net 200.00 EUR",
      );
      expect(fact(plan.preview.facts, "Total per invoice")).toBe(
        "gross 65.45 EUR → net 200.00 EUR, tax 38.00 EUR, gross 238.00 EUR",
      );
      expect(fact(plan.previewDe.facts, "Positionen")).toBe(
        "2 Positionen durch 1 Position ersetzen",
      );
    });

    it("never sends a type or a status", async () => {
      const plan = await prepare({ interval: "yearly", header: "Neu", endDate: "2027-06-01" });
      expect(plan.state.body.invoice).not.toHaveProperty("invoiceType");
      expect(plan.state.body.invoice).not.toHaveProperty("status");
      expect(plan.state.body.invoice).not.toHaveProperty("accountNextInvoice");
    });

    it("binds the approval to the exact body", async () => {
      const a = await prepare({ header: "A" });
      const b = await prepare({ header: "B" });
      expect(a.binding).toMatch(/^[0-9a-f]{64}$/);
      expect(a.binding).not.toBe(b.binding);
      expect((await prepare({ header: "A" })).binding).toBe(a.binding);
    });

    it("previews an ended template without upcoming runs", async () => {
      const plan = await prepare(
        { header: "Neu" },
        templateChangeRoutes(templateRow({ status: "50" })),
      );
      expect(fact(plan.preview.facts, "Template")).toBe("2301 (recurring invoice template, ended)");
      expect(fact(plan.preview.facts, "Next run")).toBe(
        "none while the template is ended (sevDesk keeps 2026-12-01 as its date)",
      );
      expect(fact(plan.preview.facts, "Following runs")).toBeUndefined();
      expect(plan.preview.warnings[0]).toBe(
        "The template is ended (status 50): sevDesk creates no invoice from it now. The change " +
          "applies once it is reactivated with sevdesk_invoice_reactivate_recurring.",
      );
      expect(plan.preview.warnings.some((w) => w.startsWith("Not recorded yet"))).toBe(false);
    });

    it("warns in both languages when the account's VAT regulation cannot be read", async () => {
      const plan = await prepare(
        { positions: [{ name: "Wartung", quantity: 1, unitPrice: 10, taxRate: 19 }] },
        withRoutes(templateChangeRoutes(), unknownRegimeRoute),
      );
      expect(plan.preview.warnings.at(-1)).toMatch(/^The VAT regulation of this sevDesk account/);
      expect(plan.previewDe.warnings.at(-1)).toMatch(/^Die Umsatzsteuerregelung/);
    });
  });

  describe("refuses before sending anything", () => {
    it("an invoice that is not a template, naming the draft tool", async () => {
      const message = await refusal(
        { header: "Neu" },
        templateChangeRoutes(templateRow({ invoiceType: "RE" })),
      );
      expect(message).toBe(
        "Invoice 2301 is a normal invoice (RE), not a recurring invoice template; " +
          "sevdesk_invoice_update_recurring works only on recurring invoice templates (WKR, " +
          "Abo-Rechnung). A draft invoice is changed with sevdesk_invoice_update_draft.",
      );
    });

    it("a status templates do not have", async () => {
      expect(
        await refusal({ header: "Neu" }, templateChangeRoutes(templateRow({ status: "1000" }))),
      ).toContain("has status 1000, which this server does not know for templates");
    });

    it("a call that changes nothing", async () => {
      expect(await refusal({})).toBe(
        "Nothing to change: give at least one field of the recurring invoice template besides id.",
      );
      expect(await refusal({ interval: "monthly", header: "Rechnung" })).toBe(
        "Nothing changes: recurring invoice template 2301 already has every value given.",
      );
    });

    it("a new start on a template that has run", async () => {
      const ran = templateRow({ accountLastInvoice: storedDate("2026-11-01") });
      expect(await refusal({ startDate: "2027-01-01" }, templateChangeRoutes(ran))).toContain(
        "created an invoice on 2026-11-01 already",
      );
    });

    it.each([
      [{ startDate: "2026-11-16" }, "The start date 2026-11-16 is in the past"],
      [{ startDate: "2027-01-31" }, "falls on day 31 of the month"],
      [{ endDate: "2026-11-30" }, "The end date 2026-11-30 is before the next run 2026-12-01."],
      [{ endDate: "2037-01-01" }, "more than 10 years after the next run 2026-12-01"],
      [
        { startDate: "2027-07-01" },
        "The end date 2027-06-01 is before the start date 2027-07-01.",
        templateRow({ accountEndDate: storedDate("2027-06-01") }),
      ],
      [{ endDate: "2027-06-01", removeEndDate: true }, "Give either endDate or removeEndDate"],
    ] as const)("schedule %j", async (change, message, row?: Row) => {
      expect(
        await refusal(
          change,
          row === undefined ? templateChangeRoutes() : templateChangeRoutes(row),
        ),
      ).toContain(message);
    });

    it("a total of zero", async () => {
      expect(
        await refusal({ positions: [{ name: "Gratis", quantity: 1, unitPrice: 0, taxRate: 19 }] }),
      ).toContain("A recurring invoice must charge something");
    });

    it("unknown arguments", () => {
      for (const extra of [
        { status: 50 },
        { invoiceType: "RE" },
        { accountNextInvoice: "2027-01-01" },
        { currency: "USD" },
        { removeEndDate: false },
        { interval: "weekly" },
      ]) {
        expect(tool.input.safeParse({ id: 2301, ...extra }).success, JSON.stringify(extra)).toBe(
          false,
        );
      }
    });
  });

  describe("after the save", () => {
    const quarterly = templateRow({ accountIntervall: "P0Y3M0W" });

    it("saves once with the commit tier and reports the template as stored", async () => {
      const client = new StagedClient(templateChangeRoutes(), templateChangeRoutes(quarterly));
      const { output } = await executeWrite(tool, { id: 2301, interval: "quarterly" }, client);
      expect(client.writes()).toEqual([
        expect.objectContaining({
          method: "POST",
          path: "/Invoice/Factory/saveInvoice",
          tier: "commit",
          body: {
            invoice: { ...head, accountIntervall: "P0Y3M0W" },
            invoicePosSave: null,
            invoicePosDelete: null,
          },
        }),
      ]);
      expect(output.data.schedule).toEqual({
        interval: "P0Y3M0W",
        intervalKey: "quarterly",
        startDate: "2026-12-01",
        nextRun: "2026-12-01",
      });
      expect(output.data.notes).toBeUndefined();
      expect(output.summary).toBe("Changed recurring invoice template 2301 (interval).");
      expect(output.affected).toEqual([{ objectName: "Invoice", id: "2301" }]);
    });

    it("says where sevDesk kept another schedule than expected", async () => {
      const client = new StagedClient(templateChangeRoutes(), templateChangeRoutes());
      const { output } = await executeWrite(
        tool,
        { id: 2301, interval: "quarterly", endDate: "2027-06-01" },
        client,
      );
      expect(output.data.notes).toEqual([
        "sevDesk stored another interval than expected (see schedule.interval). Check the " +
          "template in sevDesk.",
        "sevDesk stored the end date none instead of 2027-06-01. Check the template in sevDesk " +
          "before its next run.",
      ]);
      expect(output.summary).toMatch(/ See notes\.$/);
    });

    it("notices a position change sevDesk ignored (a price kept, recorded 2026-11-17)", async () => {
      const positions = [{ name: "Beratung", quantity: 3, unitPrice: "12.00", taxRate: 19 }];
      // sevDesk kept the old price 10 and the old total.
      const [first] = templatePositionRows();
      const after = templateChangeRoutes(
        templateRow({ sumNet: "30", sumTax: "5.7", sumGross: "35.7" }),
        [{ ...first, id: "5303" }],
      );
      const client = new StagedClient(templateChangeRoutes(), after);
      const { output } = await executeWrite(tool, { id: 2301, positions }, client);
      expect(output.data.notes).toEqual([
        "Position 1 as stored differs from what was sent (unit price): sevDesk may have ignored " +
          "the change. Check it in sevDesk before the template's next run.",
        "sevDesk computed a gross total of 35.70 EUR per invoice; the preview expected 42.84 " +
          "EUR. Check the template's positions and price mode in sevDesk before its next run.",
      ]);
    });

    it("notices a type or status sevDesk changed, and a lost position", async () => {
      const after = templateChangeRoutes(templateRow({ invoiceType: "RE", status: "200" }), [
        templatePositionRows()[0] ?? {},
      ]);
      const client = new StagedClient(templateChangeRoutes(), after);
      const { output } = await executeWrite(tool, { id: 2301, header: "Neu" }, client);
      expect(output.data.notes).toEqual([
        "sevDesk now stores invoice 2301 with another type than WKR (see invoice.type), so it " +
          "may no longer be a recurring template. Check it in sevDesk.",
        "sevDesk stored the template with status 200 instead of 100. Check it in sevDesk.",
        "sevDesk now stores 1 positions instead of the 2 kept. Check the template's positions " +
          "in sevDesk before its next run.",
      ]);
    });

    it("refuses an answer with another id as a completed write, without a second attempt", async () => {
      const other = withRoutes(templateChangeRoutes(), {
        method: "POST",
        path: "/Invoice/Factory/saveInvoice",
        response: { body: { objects: { invoice: { id: "2399", objectName: "Invoice" } } } },
      });
      const client = new FakeSevdeskClient(other);
      const error = await executeWrite(tool, { id: 2301, header: "Neu" }, client).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toMatchObject({
        kind: "unexpected_response",
        completedWrites: [{ objectName: "Invoice", id: "2399" }],
      });
      expect(client.writes()).toHaveLength(1);
    });

    it("reads a template that is not there as a refusal", async () => {
      const missing = [
        {
          path: "/Invoice/2301",
          response: { error: new SevdeskError({ kind: "not_found", message: "Not found." }) },
        },
        ...templateRoutes(templateRow()).slice(1),
        ...templateChangeRoutes(),
      ];
      expect(await refusal({ header: "Neu" }, missing)).toContain(
        "Invoice 2301 does not exist in sevDesk.",
      );
    });
  });
});
