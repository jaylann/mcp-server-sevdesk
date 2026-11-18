import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FIRST_RUN_TODAY,
  RUN_DATE_BEHAVIOUR,
  RUN_DATE_ON_AT_STORED_TIME,
} from "../../../../src/domain/recurring/run-date.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { invoiceUpdateRecurringTool as tool } from "../../../../src/tools/invoices/recurring-update.js";
import { ACCOUNT_RECURRING_INVOICES } from "../../../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import {
  discountRow,
  discountsRoute,
  TIMESTAMPS,
  unknownRegimeRoute,
  withRoutes,
} from "../drafts/routes.js";
import { StagedClient } from "../lifecycle/helpers.js";
import {
  generatedRoute,
  generatedRow,
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
        "Change recurring invoice template 2301 (Abo-Rechnung) for contact 1001: interval.",
      );
      expect(plan.preview.facts).toEqual([
        { label: "Template", value: "2301 (recurring invoice template, active)" },
        { label: "Automatic generation (Automatische Generierung)", value: "on" },
        { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
        {
          label: "Interval",
          value: "monthly (P0Y1M0W) → quarterly, every 3 months on day 1 (P0Y3M0W)",
        },
        { label: "Next run", value: "2026-12-01" },
        { label: "Following runs", value: "2027-03-01, 2027-06-01, 2027-09-01" },
        { label: "End", value: "none (the template runs until it is ended)" },
        { label: "Total per invoice", value: "unchanged: gross 65.45 EUR" },
      ]);
      expect(plan.preview.warnings).toEqual([
        "Every invoice sevDesk creates from this template by itself after the change carries " +
          "it; nobody is asked again. This approval covers all of them until the template ends.",
        "Invoices sevDesk already created from this template stay as they are; the change " +
          "applies only to later ones.",
        RUN_DATE_BEHAVIOUR.on.en,
        "With a new interval sevDesk keeps the next run (2026-12-01); the runs after it follow " +
          "the new interval.",
      ]);
    });

    it("says the same in German, in the same order", async () => {
      const plan = await prepare({ interval: "quarterly", endDate: "2027-06-01" });
      expect(plan.previewDe.action).toBe(
        "Abo-Rechnung 2301 für Kontakt 1001 ändern: Intervall, Enddatum.",
      );
      expect(plan.previewDe.facts.map((f) => f.label)).toEqual([
        "Vorlage",
        "Automatische Generierung",
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
        // The last run falls on the end date, which sevDesk may or may not still run (D-111).
        "01.06.2027 (bis dahin 2 oder 3 Ausführungen, die erste eingeschlossen: 3, wenn sevDesk " +
          "die Vorlage am Enddatum noch ausführt)",
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
        "2026-12-01 → 2027-01-01 (also the next run; the last run is cleared)",
      );
      expect(plan.preview.warnings).toContainEqual(
        expect.stringMatching(
          /^sevDesk moves the next run to the new start date as well and clears the template's last run/,
        ),
      );
    });

    it("a new start after the newest period the template generated (found by origin)", async () => {
      const billed = [
        generatedRow("9001", "2026-11-01", "2026-11-30"),
        generatedRow("9002", "2026-12-01", "2026-12-31"),
        // Should sevDesk not filter by origin: another template's invoice and one made from an
        // order with the same id are not counted.
        {
          ...generatedRow("9003", "2027-01-01", "2027-03-31"),
          origin: { id: "2399", objectName: "Invoice" },
        },
        {
          ...generatedRow("9004", "2027-01-01", "2027-03-31"),
          origin: { id: "2301", objectName: "Order" },
        },
      ];
      const table = [generatedRoute(billed), ...templateChangeRoutes()];
      expect(await refusal({ startDate: "2026-12-01" }, table)).toContain(
        "has already billed the period up to 2026-12-31",
      );
      const plan = await prepare({ startDate: "2027-01-01" }, table);
      expect(plan.state.body.invoice).toEqual({ ...head, accountStartDate: JAN_1 });
    });

    it("a new start when a generated invoice has no delivery date: its period cannot be told", async () => {
      const undated = (origin: string): Row => ({
        ...generatedRow("9001", "2026-11-01", "2026-11-30"),
        origin: { id: origin, objectName: "Invoice" },
        deliveryDate: null,
        deliveryDateUntil: null,
      });
      const dated = generatedRow("9002", "2026-10-01", "2026-10-31");
      // 2026-11-20 lies after the dated period but could lie inside the undated one.
      const table = [generatedRoute([dated, undated("2301")]), ...templateChangeRoutes()];
      expect(await refusal({ startDate: "2026-11-20" }, table)).toBe(
        "Invoice 9001 generated from recurring invoice template 2301 has no delivery date " +
          "(Lieferdatum or Leistungszeitraum), so the newest period the template has billed " +
          "cannot be told, and a new start date could bill a period again. Check that invoice " +
          "in sevDesk, or change the template's start date in the sevDesk web app.",
      );
      // Another template's undated invoice is not counted.
      const other = [generatedRoute([dated, undated("2399")]), ...templateChangeRoutes()];
      expect((await prepare({ startDate: "2026-11-20" }, other)).state.schedule).toMatchObject({
        nextRun: "2026-11-20",
      });
    });

    it("switches automatic generation off, and says what that means", async () => {
      const plan = await prepare({ autoGenerate: false });
      expect(plan.state.body.invoice).toEqual({
        ...head,
        propertyAutoGenerateRecurringInvoice: false,
      });
      expect(plan.preview.action).toMatch(/: automatic generation\.$/);
      expect(fact(plan.preview.facts, "Automatic generation (Automatische Generierung)")).toBe(
        "on → off (never set or switched off)",
      );
      expect(fact(plan.previewDe.facts, "Automatische Generierung")).toBe(
        "an → aus (nie gesetzt oder ausgeschaltet)",
      );
      expect(plan.preview.warnings).toContain(RUN_DATE_BEHAVIOUR.off.en);
      expect(plan.preview.warnings).not.toContain(RUN_DATE_BEHAVIOUR.on.en);
      expect(plan.previewDe.warnings).toContain(RUN_DATE_BEHAVIOUR.off.de);
    });

    it("switches automatic generation on for a next run after today", async () => {
      const off = templateChangeRoutes(templateRow({ propertyAutoGenerateRecurringInvoice: null }));
      const plan = await prepare({ autoGenerate: true }, off);
      expect(plan.state.body.invoice).toEqual({
        ...head,
        propertyAutoGenerateRecurringInvoice: true,
      });
      expect(fact(plan.preview.facts, "Automatic generation (Automatische Generierung)")).toBe(
        "off (never set or switched off) → on",
      );
      expect(plan.preview.warnings).toEqual(
        expect.arrayContaining([RUN_DATE_BEHAVIOUR.on.en, RUN_DATE_BEHAVIOUR.autoSending.en]),
      );
      expect(plan.preview.warnings).not.toContain(FIRST_RUN_TODAY.en);
    });

    it("switches it on for a next run today: the first draft comes at once", async () => {
      const today = storedDate("2026-11-17");
      const off = templateChangeRoutes(
        templateRow({
          propertyAutoGenerateRecurringInvoice: null,
          accountStartDate: today,
          accountNextInvoice: today,
        }),
      );
      const plan = await prepare({ autoGenerate: true }, off);
      expect(plan.preview.warnings).toContain(FIRST_RUN_TODAY.en);
      expect(plan.previewDe.warnings).toContain(FIRST_RUN_TODAY.de);
    });

    it("switches it on for a next run today at a later stored time: names that time", async () => {
      const at = "2026-11-17T23:00:00+01:00";
      const web = templateChangeRoutes(
        templateRow({
          propertyAutoGenerateRecurringInvoice: null,
          accountStartDate: at,
          accountNextInvoice: at,
        }),
      );
      const plan = await prepare({ autoGenerate: true }, web);
      expect(plan.preview.warnings).toContain(
        "The next run is today at 23:00 (Berlin time), the time stored with it: sevDesk creates " +
          "a draft within about a minute of that time, or within about a minute of the change if " +
          "that time has passed by then.",
      );
      expect(plan.previewDe.warnings).toContain(
        "Die nächste Ausführung ist heute um 23:00 Uhr (Berliner Zeit), der mit ihr gespeicherten " +
          "Uhrzeit: sevDesk erzeugt etwa eine Minute danach einen Entwurf, oder etwa eine Minute " +
          "nach dem Speichern der Änderung, wenn diese Uhrzeit dann schon vorbei ist.",
      );
      expect(plan.preview.warnings).not.toContain(FIRST_RUN_TODAY.en);
      expect(plan.preview.warnings.join(" ")).not.toMatch(/due at once/);
    });

    it("switches it on for a past next run only together with a new start", async () => {
      const past = storedDate("2026-11-01");
      const off = templateChangeRoutes(
        templateRow({
          propertyAutoGenerateRecurringInvoice: null,
          accountStartDate: past,
          accountNextInvoice: past,
        }),
      );
      const plan = await prepare({ autoGenerate: true, startDate: "2027-01-01" }, off);
      expect(plan.state.body.invoice).toEqual({
        ...head,
        accountStartDate: JAN_1,
        propertyAutoGenerateRecurringInvoice: true,
      });
      expect(plan.preview.warnings).not.toContain(FIRST_RUN_TODAY.en);
    });

    it("a template made in the web app: its interval and run time as stored", async () => {
      const at = "2026-12-01T11:08:00+01:00";
      const web = templateChangeRoutes(
        templateRow({
          accountIntervall: "P0Y0M1W",
          accountStartDate: at,
          accountNextInvoice: at,
        }),
      );
      const plan = await prepare({ header: "Neu" }, web);
      expect(plan.state.body.invoice).toEqual({ ...head, header: "Neu" });
      expect(fact(plan.preview.facts, "Interval")).toBe("every 1 week (P0Y0M1W)");
      expect(fact(plan.previewDe.facts, "Intervall")).toBe("P0Y0M1W");
      expect(fact(plan.preview.facts, "Following runs")).toBe(
        "not computed: the stored interval is not one this server offers",
      );
      expect(plan.preview.warnings).toContain(RUN_DATE_ON_AT_STORED_TIME.en);
      expect(plan.preview.warnings).not.toContain(RUN_DATE_BEHAVIOUR.on.en);
      expect(plan.preview.warnings.join(" ")).not.toMatch(/00:00|midnight \(/);
      expect(plan.preview.warnings).toContain(
        "The stored interval is not one this server offers, so the following runs are not " +
          "listed; set interval to replace it.",
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

    it("a content change on a run day: today's draft may keep the old content", async () => {
      const today = storedDate("2026-11-17");
      const runsToday = (overrides: Row = {}): FakeRoute[] =>
        templateChangeRoutes(
          templateRow({ accountStartDate: today, accountNextInvoice: today, ...overrides }),
        );
      const en =
        "The next run is today: a draft sevDesk has already created from this template today, or " +
        "creates before this change is saved, keeps the old content. Check today's draft before " +
        "it is finalized.";
      const de =
        "Die nächste Ausführung ist heute: Ein Entwurf, den sevDesk heute schon aus dieser " +
        "Vorlage erzeugt hat oder vor dem Speichern dieser Änderung erzeugt, behält den alten " +
        "Inhalt. Prüfe den heutigen Entwurf, bevor er fertiggestellt wird.";
      const plan = await prepare(
        {
          header: "Neu",
          positions: [{ name: "Wartung", quantity: 1, unitPrice: 10, taxRate: 19 }],
        },
        runsToday(),
      );
      // Right after the consequences, in the same place in both languages.
      expect(plan.preview.warnings[2]).toBe(en);
      expect(plan.previewDe.warnings[2]).toBe(de);
      expect(plan.previewDe.warnings).toHaveLength(plan.preview.warnings.length);
      // Not for a schedule change, without generation, nor when the call switches it on (the
      // first draft then comes after the save).
      const schedule = await prepare({ interval: "quarterly" }, runsToday());
      expect(schedule.preview.warnings).not.toContain(en);
      const off = runsToday({ propertyAutoGenerateRecurringInvoice: null });
      expect((await prepare({ header: "Neu" }, off)).preview.warnings).not.toContain(en);
      const switched = await prepare({ header: "Neu", autoGenerate: true }, off);
      expect(switched.preview.warnings).not.toContain(en);
      expect(switched.preview.warnings).toContain(FIRST_RUN_TODAY.en);
      // Nor on another day.
      expect((await prepare({ header: "Neu" })).preview.warnings).not.toContain(en);
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
      expect(plan.preview.warnings).not.toContain(RUN_DATE_BEHAVIOUR.on.en);
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

    it("a template with automatic sending on, or whose settings sevDesk did not return", async () => {
      const sending = templateChangeRoutes(
        templateRow({ autoSendConfiguration: { id: "77", sendType: "VM" } }),
      );
      const sent = await refusal({ header: "Neu" }, sending);
      expect(sent).toContain("automatic sending");
      expect(sent).toContain("sevdesk_invoice_end_recurring");
      const unread = templateRow();
      delete unread.autoSendConfiguration;
      expect(await refusal({ header: "Neu" }, templateChangeRoutes(unread))).toContain(
        "could not be checked",
      );
      const noGeneration = templateRow();
      delete noGeneration.propertyAutoGenerateRecurringInvoice;
      expect(await refusal({ header: "Neu" }, templateChangeRoutes(noGeneration))).toContain(
        "could not be checked",
      );
    });

    it("switching generation on with a next run before today, naming the catch-up", async () => {
      const past = storedDate("2026-11-01");
      const off = templateChangeRoutes(
        templateRow({
          propertyAutoGenerateRecurringInvoice: null,
          accountStartDate: past,
          accountNextInvoice: past,
        }),
      );
      const message = await refusal({ autoGenerate: true }, off);
      expect(message).toContain("one a minute");
      expect(message).toContain("Give a new startDate in the same call.");
    });

    describe("an end date change that lets a past next run happen (catch-up, D-111)", () => {
      // An active template with generation on whose kept next run (2026-07-01) lies before today
      // and after its end date (2026-06-30). What sevDesk does on reaching an end date is not
      // recorded; with that end date gone, nothing recorded keeps it from catching up one draft
      // per missed period, a minute apart, as it does for a start in the past.
      const stopped = (overrides: Row = {}): FakeRoute[] =>
        templateChangeRoutes(
          templateRow({
            accountStartDate: storedDate("2026-01-01"),
            accountNextInvoice: storedDate("2026-07-01"),
            accountEndDate: storedDate("2026-06-30"),
            ...overrides,
          }),
        );

      it.each([[{ removeEndDate: true }], [{ endDate: "2027-12-31" }]] as const)(
        "refuses %j, naming the catch-up",
        async (change) => {
          expect(await refusal(change, stopped())).toBe(
            "The next run of recurring invoice template 2301 is 2026-07-01: before today " +
              "(2026-11-17 in Berlin) and after its end date 2026-06-30, with automatic " +
              "generation on. With the end date removed or moved past that run, sevDesk could " +
              "catch up and create a draft for every period since then, one a minute, as it does " +
              "for a start in the past; no preview shows those drafts. Give a new startDate in " +
              "the same call.",
          );
        },
      );

      it("refuses it with a generation value whose meaning is not recorded", async () => {
        const unrecorded = stopped({ propertyAutoGenerateRecurringInvoice: "0" });
        expect(await refusal({ removeEndDate: true }, unrecorded)).toContain(
          "with automatic generation stored as a value whose meaning is not recorded",
        );
      });

      it("passes with a new start, with generation off, ended, or with the end date kept", async () => {
        const restarted = await prepare(
          { removeEndDate: true, startDate: "2026-12-01" },
          stopped(),
        );
        expect(restarted.state.body.invoice).toMatchObject({ accountEndDate: null });
        expect(restarted.state.schedule).toMatchObject({ nextRun: "2026-12-01" });
        expect(restarted.state.schedule.endDate).toBeUndefined();
        const off = stopped({ propertyAutoGenerateRecurringInvoice: null });
        await prepare({ removeEndDate: true }, off);
        await prepare({ removeEndDate: true, autoGenerate: false }, stopped());
        await prepare({ endDate: "2027-12-31" }, stopped({ status: "50" }));
        await prepare({ header: "Neu" }, stopped());
      });
    });

    it("an unchanged switch is no change", async () => {
      expect(await refusal({ autoGenerate: true })).toBe(
        "Nothing changes: recurring invoice template 2301 already has every value given.",
      );
    });

    it.each([
      [{ startDate: "2026-11-16" }, "The new start date 2026-11-16 is not after today (2026-11-17"],
      [{ startDate: "2026-11-17" }, "The new start date 2026-11-17 is not after today"],
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

  describe("a discount on the whole template (D-116; review of #124, M2)", () => {
    // Template 2301 with 10 % off its 55.00 net (as sevDesk sums it: 49.50 + 9.40 = 58.90).
    const discounted = templateRow({ sumNet: "49.5", sumTax: "9.4", sumGross: "58.9" });
    const tenPercent = discountRow("Invoice", 2301);
    const withDiscounts = (
      rows: readonly Row[],
      row: Row = discounted,
      positions?: readonly Row[],
    ): FakeRoute[] => [
      discountsRoute("Invoice", 2301, rows),
      ...templateChangeRoutes(row, positions),
    ];
    const wartung = [{ name: "Wartung", quantity: 1, unitPrice: "80.00", taxRate: 19 }];
    // sevDesk keeps the discount when every position is replaced (recorded 2026-11-18, D-116).
    const keptEn =
      "This template has a discount on the whole document, which the change leaves alone: " +
      "sevDesk keeps it when every position is replaced, so it applies to the new positions, " +
      "and the total per invoice above counts it.";
    const keptDe =
      "Diese Vorlage hat einen Rabatt auf den Gesamtbetrag, den die Änderung nicht berührt: " +
      "sevDesk behält ihn, wenn alle Positionen ersetzt werden, er gilt also für die neuen " +
      "Positionen, und die Summe je Rechnung oben rechnet ihn ein.";

    it("counts a kept single net discount in the totals of new positions, and says sevDesk keeps it", async () => {
      const plan = await prepare({ positions: wartung }, withDiscounts([tenPercent]));
      // The body leaves the discount alone.
      expect(plan.state.body).not.toHaveProperty("discountSave");
      expect(plan.state.body).not.toHaveProperty("discountDelete");
      // 80.00 net less 10 % (8.00) and its tax (1.52): 72.00 + 13.68.
      expect(plan.state.positions?.expected).toEqual({
        net: "72.00",
        tax: "13.68",
        gross: "85.68",
      });
      expect(fact(plan.preview.facts, "Discount on the whole document (Rabatt)")).toBe(
        'unchanged: 10 % of the net total ("Rabatt")',
      );
      expect(fact(plan.preview.facts, "Total per invoice")).toBe(
        "gross 58.90 EUR → net 72.00 EUR, tax 13.68 EUR, gross 85.68 EUR",
      );
      expect(fact(plan.previewDe.facts, "Rabatt auf den Gesamtbetrag")).toBe(
        "unverändert: 10 % vom Nettobetrag („Rabatt“)",
      );
      expect(fact(plan.previewDe.facts, "Summe je Rechnung")).toBe(
        "brutto 58,90 EUR → netto 72,00 EUR, USt. 13,68 EUR, brutto 85,68 EUR",
      );
      // In the same place in both languages.
      const at = plan.preview.warnings.indexOf(keptEn);
      expect(at).toBeGreaterThan(0);
      expect(plan.previewDe.warnings[at]).toBe(keptDe);
      expect(plan.previewDe.warnings).toHaveLength(plan.preview.warnings.length);
    });

    it("shows a kept discount without the warning when the positions stay", async () => {
      const plan = await prepare({ header: "Neu" }, withDiscounts([tenPercent]));
      expect(fact(plan.preview.facts, "Discount on the whole document (Rabatt)")).toBe(
        'unchanged: 10 % of the net total ("Rabatt")',
      );
      expect(fact(plan.preview.facts, "Total per invoice")).toBe("unchanged: gross 58.90 EUR");
      expect(plan.preview.warnings).not.toContain(keptEn);
    });

    it("leaves the total to sevDesk with several discounts, and says why in both languages", async () => {
      const two = [tenPercent, discountRow("Invoice", 2301, { id: "9002", value: "5" })];
      const plan = await prepare({ positions: wartung }, withDiscounts(two));
      expect(plan.state.positions?.expected).toBeUndefined();
      expect(fact(plan.preview.facts, "Total per invoice")).toBe(
        "gross 58.90 EUR → computed by sevDesk (see warnings)",
      );
      expect(fact(plan.previewDe.facts, "Summe je Rechnung")).toBe(
        "brutto 58,90 EUR → berechnet sevDesk (siehe Hinweise)",
      );
      expect(plan.preview.warnings).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^This document has 2 discounts on the whole document/),
          "This template has a discount on the whole document, which the change leaves alone: " +
            "sevDesk keeps it when every position is replaced, so it applies to the new positions.",
          "The template's discounts on the whole document (several, a surcharge or a percentage " +
            "stored as gross) are not computed here: sevDesk computes the total per invoice. " +
            "Check it in the result before the template's next run.",
        ]),
      );
      expect(plan.previewDe.warnings).toEqual(
        expect.arrayContaining([
          "Die Rabatte der Vorlage auf den Gesamtbetrag (mehrere, ein Aufschlag oder ein " +
            "Prozentsatz, der als brutto gespeichert ist) werden hier nicht berechnet: sevDesk " +
            "berechnet die Summe je Rechnung. Prüfe sie im Ergebnis vor der nächsten Ausführung " +
            "der Vorlage.",
        ]),
      );
      expect(plan.previewDe.warnings).toHaveLength(plan.preview.warnings.length);
    });

    it("counts a kept percentage on new gross prices off the gross total (recorded 2026-11-18)", async () => {
      // 95.20 gross at 19 %: 10 % takes 9.52 off the gross, 85.68 / 1.19 = 72.00 net (D-116).
      const gross = [{ ...wartung[0], unitPrice: "95.20" }];
      const plan = await prepare(
        { positions: gross, priceMode: "gross" },
        withDiscounts([tenPercent]),
      );
      expect(plan.state.positions?.expected).toEqual({
        net: "72.00",
        tax: "13.68",
        gross: "85.68",
      });
    });

    it("computes a kept fixed amount on gross prices (recorded 2026-11-18)", async () => {
      // On gross prices sevDesk takes a fixed amount off the gross total: 95.20 − 5.00 = 90.20,
      // 90.20 / 1.19 = 75.80 net (D-116).
      const gross = [{ ...wartung[0], unitPrice: "95.20" }];
      const fixed = discountRow("Invoice", 2301, { percentage: "0", value: "5" });
      const plan = await prepare({ positions: gross, priceMode: "gross" }, withDiscounts([fixed]));
      expect(plan.state.positions?.expected).toEqual({
        net: "75.80",
        tax: "14.40",
        gross: "90.20",
      });
      expect(fact(plan.preview.facts, "Discount on the whole document (Rabatt)")).toBe(
        'unchanged: 5.00 EUR gross ("Rabatt")',
      );
      expect(plan.preview.warnings.join(" ")).not.toContain("not computed here");
    });

    it("leaves the total to sevDesk for a kept fixed amount above the new total", async () => {
      const gross = [{ ...wartung[0], unitPrice: "95.20" }];
      const fixed = discountRow("Invoice", 2301, { percentage: "0", value: "100" });
      const plan = await prepare({ positions: gross, priceMode: "gross" }, withDiscounts([fixed]));
      expect(plan.state.positions?.expected).toBeUndefined();
      expect(plan.preview.warnings).toContainEqual(
        expect.stringMatching(/^The total per invoice with the kept discount is not computed here/),
      );
      expect(plan.previewDe.warnings).toContainEqual(
        expect.stringMatching(/^Die Summe je Rechnung mit dem erhaltenen Rabatt wird hier nicht/),
      );
    });

    it("reads the discount back: no gross note when it was kept, a note when it is gone", async () => {
      const [first] = templatePositionRows();
      const stored = {
        ...first,
        id: "5303",
        name: "Wartung",
        quantity: "1",
        price: "80",
        priceNet: "80",
        priceGross: "95.2",
        priceTax: "15.2",
        sumNet: "80",
        sumTax: "15.2",
        sumGross: "95.2",
      };
      const keptClient = new StagedClient(
        withDiscounts([tenPercent]),
        withDiscounts(
          [tenPercent],
          templateRow({ sumNet: "72", sumTax: "13.68", sumGross: "85.68" }),
          [stored],
        ),
      );
      const ok = await executeWrite(tool, { id: 2301, positions: wartung }, keptClient);
      expect(ok.output.data.notes).toBeUndefined();
      expect(ok.output.data.discount).toMatchObject({
        items: [{ kind: "percent", value: "10", basis: "net" }],
      });

      // sevDesk dropped the discount with the positions: both the total and the discount say so.
      const lost = new StagedClient(
        withDiscounts([tenPercent]),
        templateChangeRoutes(templateRow({ sumNet: "80", sumTax: "15.2", sumGross: "95.2" }), [
          stored,
        ]),
      );
      const gone = await executeWrite(tool, { id: 2301, positions: wartung }, lost);
      expect(gone.output.data.notes).toEqual([
        "sevDesk computed a gross total of 95.20 EUR per invoice; the preview expected 85.68 " +
          "EUR. Check the template's positions, price mode and discount in sevDesk before its " +
          "next run.",
        "sevDesk lists 0 discount(s) on the whole template after the save; it had 1 before, " +
          "which the change did not touch. Check the template's discount and its total per " +
          "invoice in sevDesk before its next run.",
      ]);
      expect(gone.output.data.discount).toBeUndefined();
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
        every: "every 3 months",
        startDate: "2026-12-01",
        nextRun: "2026-12-01",
        autoGenerate: "on",
        autoSendConfigured: false,
      });
      expect(output.data.notes).toBeUndefined();
      expect(output.summary).toBe("Changed recurring invoice template 2301 (interval).");
      expect(output.affected).toEqual([{ objectName: "Invoice", id: "2301" }]);
    });

    it("checks the switch read back after changing it", async () => {
      const stillOn = new StagedClient(templateChangeRoutes(), templateChangeRoutes());
      const kept = await executeWrite(tool, { id: 2301, autoGenerate: false }, stillOn);
      expect(stillOn.writes()).toHaveLength(1);
      expect(kept.output.data.notes).toEqual([
        expect.stringMatching(
          /^sevDesk stored automatic generation \(Automatische Generierung\) as on although/,
        ),
      ]);
      const off = templateChangeRoutes(templateRow({ propertyAutoGenerateRecurringInvoice: null }));
      const done = new StagedClient(templateChangeRoutes(), off);
      const switched = await executeWrite(tool, { id: 2301, autoGenerate: false }, done);
      expect(switched.output.data.notes).toBeUndefined();
      expect(switched.output.data.schedule).toMatchObject({ autoGenerate: "off" });
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
          "EUR. Check the template's positions, price mode and discount in sevDesk before its " +
          "next run.",
      ]);
    });

    it("compares name, quantity and tax rate of every position read back", async () => {
      // Sent: the stored first position, and the second with a new name, quantity and rate.
      const positions = [
        { name: "Beratung", quantity: 3, unitPrice: "10.00", taxRate: 19 },
        { name: "Paket Plus", quantity: 2, unitPrice: "25.00", taxRate: 7 },
      ];
      // sevDesk kept both stored rows as they were (D-135).
      const client = new StagedClient(templateChangeRoutes(), templateChangeRoutes());
      const { output } = await executeWrite(tool, { id: 2301, positions }, client);
      expect(output.data.notes).toEqual([
        "Position 2 as stored differs from what was sent (name, quantity, tax rate): sevDesk may " +
          "have ignored the change. Check it in sevDesk before the template's next run.",
        "sevDesk computed a gross total of 65.45 EUR per invoice; the preview expected 89.20 " +
          "EUR. Check the template's positions, price mode and discount in sevDesk before its " +
          "next run.",
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
