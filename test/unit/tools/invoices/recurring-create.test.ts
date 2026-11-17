import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { invoiceCreateRecurringTool as tool } from "../../../../src/tools/invoices/recurring-create.js";
import { ACCOUNT_RECURRING_INVOICES } from "../../../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { notFound, TIMESTAMPS, unknownRegimeRoute, withRoutes } from "../drafts/routes.js";
import {
  recurringCreateArgs as args,
  recurringCreateRoutes as routes,
} from "./recurring-routes.js";

/** Berlin midnight of 2026-12-01 and 2027-03-01 in Unix seconds. */
const DEC_1 = TIMESTAMPS["2026-11-30"] + 86_400;
const MAR_1 = 1_803_855_600;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-17T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

async function prepare(callArgs: unknown, table: readonly FakeRoute[] = routes) {
  const client = new FakeSevdeskClient(table);
  const plan = await prepareWrite(tool, callArgs, client);
  return { client, plan };
}

async function refusal(callArgs: unknown, table: readonly FakeRoute[] = routes) {
  const client = new FakeSevdeskClient(table);
  const error = await prepareWrite(tool, callArgs, client).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  expect(client.writes()).toEqual([]);
  return { message: (error as SevdeskError).message, client };
}

/** The template row of the read-back fixture with `overrides`. */
function templateRow(overrides: Record<string, unknown>): Record<string, unknown> {
  const [row] = (loadFixture("recurring/template-2301.json").body as { objects: unknown[] })
    .objects as Record<string, unknown>[];
  return { ...row, ...overrides };
}

/** `GET /Invoice?invoiceType=WKR` answering `rows` (the duplicate check). */
function templatesRoute(rows: readonly Record<string, unknown>[]): FakeRoute {
  return { path: "/Invoice", query: { invoiceType: "WKR" }, response: { body: { objects: rows } } };
}

const expectedBody = {
  invoice: {
    objectName: "Invoice",
    mapAll: true,
    invoiceType: "WKR",
    status: 100,
    contact: { id: 1001, objectName: "Contact" },
    contactPerson: { id: 2001, objectName: "SevUser" },
    invoiceDate: "01.12.2026",
    deliveryDate: DEC_1,
    header: "Rechnung",
    discount: 0,
    currency: "EUR",
    showNet: true,
    taxRule: { id: 1, objectName: "TaxRule" },
    taxRate: 0,
    taxText: "Umsatzsteuerpflichtige Umsätze",
    smallSettlement: false,
    addressName: "Musterfirma GmbH, Buchhaltung",
    addressStreet: "Musterstraße 1",
    addressZip: "12345",
    addressCity: "Musterstadt",
    addressCountry: { id: 1, objectName: "StaticCountry" },
    accountIntervall: "P0Y1M0W",
    accountStartDate: DEC_1,
  },
  invoicePosSave: [
    {
      objectName: "InvoicePos",
      mapAll: true,
      quantity: 3,
      price: "10.00",
      name: "Beratung",
      unity: { id: 1, objectName: "Unity" },
      taxRate: 19,
      positionNumber: 0,
    },
    {
      objectName: "InvoicePos",
      mapAll: true,
      quantity: 1,
      price: "25.00",
      name: "Paket",
      unity: { id: 1, objectName: "Unity" },
      taxRate: 19,
      positionNumber: 1,
      text: "Zweite Zeile\nund eine dritte",
    },
  ],
  invoicePosDelete: null,
};

describe("sevdesk_invoice_create_recurring", () => {
  it("is a commit tool of the invoices toolset: destructive, not idempotent, closed world", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.toolset).toBe("invoices");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(tool.locks?.(tool.input.parse(args))).toEqual([ACCOUNT_RECURRING_INVOICES]);
  });

  it("prepares a WKR body with the schedule and reads only (D-111)", async () => {
    const { client, plan } = await prepare(args);
    expect(client.writes()).toEqual([]);
    expect(plan.state.body).toEqual(expectedBody);
    // Never the fields sevDesk ignores or drops.
    expect(plan.state.body.invoice).not.toHaveProperty("accountNextInvoice");
    expect(
      Object.keys(plan.state.body.invoice).filter((key) => key.startsWith("recurring")),
    ).toEqual([]);
    expect(plan.state.expected).toEqual({ net: "55.00", tax: "10.45", gross: "65.45" });
  });

  it("sends the end date as Unix seconds of Berlin midnight", async () => {
    const { plan } = await prepare({ ...args, endDate: "2027-03-01" });
    expect(plan.state.body.invoice.accountEndDate).toBe(MAR_1);
  });

  it.each([
    ["quarterly", "P0Y3M0W"],
    ["half_yearly", "P0Y6M0W"],
    ["yearly", "P1Y0M0W"],
  ])("sends %s as %s", async (interval, wire) => {
    const { plan } = await prepare({ ...args, interval });
    expect(plan.state.body.invoice.accountIntervall).toBe(wire);
  });

  it("previews customer, schedule, texts, positions and totals in English", async () => {
    const { plan } = await prepare({
      ...args,
      timeToPay: 14,
      headText: "<p>Ihr Wartungsvertrag</p>",
      footText: "Zahlbar ohne Abzug.",
    });
    expect(plan.preview.action).toBe(
      "Create a recurring invoice template (Abo-Rechnung) for Musterfirma GmbH (contact 1001): " +
        "65.45 EUR gross per invoice, monthly from 2026-12-01 until it is ended.",
    );
    expect(plan.preview.irreversible).toBe(false);
    expect(plan.preview.facts).toEqual([
      { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
      {
        label: "Address on the invoices",
        value: "Musterfirma GmbH, Buchhaltung, Musterstraße 1, 12345 Musterstadt, Deutschland",
      },
      { label: "Interval", value: "monthly, every month on day 1 (P0Y1M0W)" },
      { label: "First run", value: "2026-12-01" },
      { label: "Following runs", value: "2027-01-01, 2027-02-01, 2027-03-01" },
      {
        label: "End",
        value: "none (sevDesk keeps creating invoices until the template is ended)",
      },
      { label: "Contact person (Ansprechpartner)", value: "Erika Musterfrau (user 2001)" },
      { label: "Title (Betreff)", value: "Rechnung" },
      { label: "Payment term (Zahlungsziel)", value: "14 days" },
      { label: "Prices entered as", value: "net" },
      { label: "Tax rule (Steuerregel)", value: "1 Umsatzsteuerpflichtige Umsätze" },
      { label: "Tax note (Steuerhinweis)", value: "Umsatzsteuerpflichtige Umsätze" },
      { label: "Head text (Kopftext)", value: "<p>Ihr Wartungsvertrag</p>" },
      { label: "Position 1", value: "Beratung: 3 × 10.00 EUR net, 19 % VAT → net 30.00 EUR" },
      {
        label: "Position 2",
        value:
          "Paket: 1 × 25.00 EUR net, 19 % VAT → net 25.00 EUR\nText: Zweite Zeile\nund eine dritte",
      },
      { label: "Foot text (Fußtext)", value: "Zahlbar ohne Abzug." },
      { label: "Total per invoice", value: "net 55.00 EUR, tax 10.45 EUR, gross 65.45 EUR" },
    ]);
    expect(plan.preview.warnings).toEqual([
      "From the first run on, sevDesk creates an invoice from this template on every run date by " +
        "itself, with these positions and texts; nobody is asked again. This approval covers " +
        "every one of those invoices until the template ends.",
      "Not confirmed yet: what sevDesk creates on a run date (a draft, or a finalized invoice " +
        "with a number that is booked), whether it sends that invoice to the customer, and " +
        "whether a template saved with status 100 runs at all. Check the first run in sevDesk.",
      "To change, pause or end the template later, use the sevDesk web app (Abo-Rechnungen); " +
        "this server has no tool for that yet.",
    ]);
  });

  it("says the same in German, in the same order", async () => {
    const { plan } = await prepare({ ...args, endDate: "2027-02-15" });
    expect(plan.previewDe.action).toBe(
      "Abo-Rechnung (Vorlage für wiederkehrende Rechnungen) für Musterfirma GmbH (Kontakt " +
        "1001) anlegen: 65,45 EUR brutto je Rechnung, monatlich ab 01.12.2026 bis 15.02.2027.",
    );
    expect(plan.previewDe.facts.map((fact) => fact.label)).toEqual([
      "Kunde",
      "Anschrift auf den Rechnungen",
      "Intervall",
      "Erste Ausführung",
      "Folgende Ausführungen",
      "Ende",
      "Ansprechpartner",
      "Betreff",
      "Preise eingegeben als",
      "Steuerregel",
      "Steuerhinweis",
      "Position 1",
      "Position 2",
      "Summe je Rechnung",
    ]);
    const value = (label: string) => plan.previewDe.facts.find((f) => f.label === label)?.value;
    expect(value("Intervall")).toBe("monatlich, jeden Monat am 1. (P0Y1M0W)");
    expect(value("Folgende Ausführungen")).toBe("01.01.2027, 01.02.2027");
    expect(value("Ende")).toBe("15.02.2027 (bis dahin 3 Rechnungen, die erste eingeschlossen)");
    expect(value("Position 1")).toBe("Beratung: 3 × 10,00 EUR netto, 19 % USt. → netto 30,00 EUR");
    expect(value("Summe je Rechnung")).toBe("netto 55,00 EUR, USt. 10,45 EUR, brutto 65,45 EUR");
    expect(plan.previewDe.warnings).toHaveLength(plan.preview.warnings.length);
    expect(plan.preview.facts.find((f) => f.label === "End")?.value).toBe(
      "2027-02-15 (3 invoices up to then, the first included)",
    );
  });

  it("names the rule of the run day for a later interval", async () => {
    const { plan } = await prepare({ ...args, interval: "quarterly", startDate: "2026-12-15" });
    const fact = (label: string) => plan.preview.facts.find((f) => f.label === label)?.value;
    expect(fact("Interval")).toBe("quarterly, every 3 months on day 15 (P0Y3M0W)");
    expect(fact("Following runs")).toBe("2027-03-15, 2027-06-15, 2027-09-15");
  });

  it("warns when the first run is today, and when a run falls on the end date", async () => {
    const { plan } = await prepare({ ...args, startDate: "2026-11-17", endDate: "2027-01-17" });
    expect(plan.preview.warnings.slice(3)).toEqual([
      "The first run is today: sevDesk may create the first invoice as soon as the template is " +
        "saved.",
      "A run falls on the end date itself (2027-01-17); whether sevDesk still creates an " +
        "invoice on its end date is not recorded.",
    ]);
    expect(plan.previewDe.warnings.slice(3)).toEqual([
      "Die erste Ausführung ist heute: sevDesk erzeugt die erste Rechnung womöglich, sobald die " +
        "Vorlage gespeichert ist.",
      "Eine Ausführung fällt genau auf das Enddatum (17.01.2027); ob sevDesk am Enddatum selbst " +
        "noch eine Rechnung erzeugt, ist nicht erfasst.",
    ]);
    expect(plan.preview.facts.find((f) => f.label === "Following runs")?.value).toBe(
      "2026-12-17, 2027-01-17",
    );
  });

  it("says when no run follows the first", async () => {
    const { plan } = await prepare({ ...args, endDate: "2026-12-01" });
    expect(plan.preview.facts.find((f) => f.label === "Following runs")?.value).toBe(
      "none before the end date",
    );
    expect(plan.previewDe.facts.find((f) => f.label === "Folgende Ausführungen")?.value).toBe(
      "keine bis zum Enddatum",
    );
  });

  it("warns about a template of the customer with the same total, unless it is deactivated", async () => {
    const same = templateRow({ id: "2299", status: "200" });
    const deactivated = templateRow({ id: "2298", status: "50" });
    const otherTotal = templateRow({ id: "2297", sumGross: "65.46" });
    const otherContact = templateRow({
      id: "2296",
      contact: { id: "1002", objectName: "Contact" },
    });
    const { plan } = await prepare(
      args,
      withRoutes(routes, templatesRoute([same, deactivated, otherTotal, otherContact])),
    );
    expect(plan.preview.warnings.slice(3)).toEqual([
      "Possible duplicate: template 2299 for the same customer with the same gross total " +
        "(65.45 EUR) exists already and is not deactivated. Every template bills the customer " +
        "on its own.",
    ]);
    expect(plan.previewDe.warnings.slice(3)).toEqual([
      "Mögliches Duplikat: Vorlage 2299 für denselben Kunden mit derselben Bruttosumme " +
        "(65,45 EUR) besteht bereits und ist nicht deaktiviert. Jede Vorlage stellt dem Kunden " +
        "eigene Rechnungen.",
    ]);
  });

  it("asks sevDesk for the customer's templates only (showWkr, invoiceType WKR, contact)", async () => {
    const { client } = await prepare(args);
    const list = client.callsTo("/Invoice");
    expect(list).toHaveLength(1);
    expect(list[0]?.query).toMatchObject({
      invoiceType: "WKR",
      showWkr: "all",
      "contact[id]": 1001,
    });
  });

  it("warns in both languages when the account's VAT regulation cannot be read", async () => {
    const { plan } = await prepare(args, withRoutes(routes, unknownRegimeRoute));
    expect(plan.preview.warnings.at(-1)).toMatch(/^The VAT regulation of this sevDesk account/);
    expect(plan.previewDe.warnings.at(-1)).toMatch(
      /^Die Umsatzsteuerregelung dieses sevDesk-Kontos/,
    );
  });

  it("binds the approval to the exact body", async () => {
    const base = await prepare(args);
    const same = await prepare(args);
    const otherText = await prepare({ ...args, footText: "Andere Bankverbindung." });
    expect(base.plan.binding).toMatch(/^[0-9a-f]{64}$/);
    expect(same.plan).toEqual(base.plan);
    expect(otherText.plan.binding).not.toBe(base.plan.binding);
  });

  it("saves once with the commit tier, reads the template back and reports its schedule", async () => {
    const client = new FakeSevdeskClient(routes);
    const { output } = await executeWrite(tool, args, client);
    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/Invoice/Factory/saveInvoice",
        tier: "commit",
        body: expectedBody,
      }),
    ]);
    expect(output.affected).toEqual([{ objectName: "Invoice", id: "2301" }]);
    expect(output.data.invoice).toMatchObject({
      id: 2301,
      type: { code: "WKR" },
      status: { code: 100 },
      recurring: { interval: "P0Y1M0W", nextInvoice: "2026-12-01" },
    });
    expect(output.data.positions.map((position) => position.name)).toEqual(["Beratung", "Paket"]);
    expect(output.data.schedule).toEqual({
      interval: "P0Y1M0W",
      intervalKey: "monthly",
      startDate: "2026-12-01",
      nextRun: "2026-12-01",
    });
    expect(output.data.notes).toBeUndefined();
    expect(output.summary).toBe(
      "Created recurring invoice template 2301 (monthly from 2026-12-01, gross 65.45 EUR per " +
        "invoice).",
    );
  });

  it("says where sevDesk stored another schedule, type, status or total than was sent", async () => {
    const stored = templateRow({
      invoiceType: "RE",
      status: "200",
      sumGross: "70",
      accountStartDate: "2027-01-01T00:00:00+01:00",
      accountNextInvoice: "2027-01-01T00:00:00+01:00",
    });
    const client = new FakeSevdeskClient(
      withRoutes(routes, {
        path: "/Invoice/2301",
        query: { embed: "contact" },
        response: { body: { objects: [stored] } },
      }),
    );
    const { output } = await executeWrite(tool, args, client);
    expect(output.data.notes).toEqual([
      "sevDesk stored invoice 2301 with another type than WKR (see invoice.type), so it may not " +
        "be a recurring template at all. Check it in sevDesk.",
      "sevDesk stored the template with status 200 instead of 100. Check it in sevDesk.",
      "sevDesk computed a gross total of 70.00 EUR per invoice; the preview expected 65.45 EUR. " +
        "Check the template's positions and price mode in sevDesk before its first run: every " +
        "invoice carries them.",
      "sevDesk stored the start date 2027-01-01 instead of 2026-12-01. Check the template in " +
        "sevDesk before its first run.",
      "sevDesk set the next run to 2027-01-01, not to the start date 2026-12-01. Check the " +
        "template in sevDesk before its first run.",
    ]);
    expect(output.summary).toMatch(/ See notes\.$/);
  });

  describe("refuses before sending anything", () => {
    it.each([
      [
        "a start date in the past",
        { startDate: "2026-11-16" },
        "The start date 2026-11-16 is in the past (today is 2026-11-17 in Berlin).",
      ],
      [
        "a start date more than a year ahead",
        { startDate: "2027-12-01" },
        "The start date 2027-12-01 is more than a year ahead",
      ],
      [
        "a start on the 31st",
        { startDate: "2026-12-31" },
        "The start date 2026-12-31 falls on day 31 of the month.",
      ],
      [
        "an end before the start",
        { endDate: "2026-11-30" },
        "The end date 2026-11-30 is before the start date 2026-12-01.",
      ],
      [
        "an end more than ten years ahead",
        { endDate: "2037-01-01" },
        "The end date 2037-01-01 is more than 10 years after the start date 2026-12-01",
      ],
    ])("%s, without any request", async (_label, change, message) => {
      const { message: actual, client } = await refusal({ ...args, ...change });
      expect(actual).toContain(message);
      expect(client.calls).toEqual([]);
    });

    it.each([
      ["zero", [{ name: "Gratis", quantity: 1, unitPrice: 0, taxRate: 19 }], "0.00"],
      ["negative", [{ name: "Gutschrift", quantity: 1, unitPrice: -10, taxRate: 19 }], "-11.90"],
    ])("a %s total", async (_label, positions, gross) => {
      const { message } = await refusal({ ...args, positions });
      expect(message).toBe(
        `Every invoice of this template would total ${gross} EUR gross. A recurring invoice ` +
          "must charge something: check the positions (a credit to the customer is a credit " +
          "note, not a recurring invoice).",
      );
    });

    it("the checks of the invoice draft: an expense tax rule, a rate the rule does not allow", async () => {
      expect((await refusal({ ...args, taxRuleId: 9 })).message).toContain(
        "Tax rule 9 (Vorsteuerabziehbare Aufwendungen) cannot be used for invoices",
      );
      expect(
        (
          await refusal({
            ...args,
            positions: [{ name: "A", quantity: 1, unitPrice: 1, taxRate: 16 }],
          })
        ).message,
      ).toContain("Position 1 has a tax rate of 16 %");
    });

    it("a contact that does not exist", async () => {
      const { message } = await refusal(args, withRoutes(routes, notFound("/Contact/1001")));
      expect(message).toContain("Contact 1001 does not exist in sevDesk.");
    });

    it("unknown arguments, another currency, a weekly interval, a non-date", () => {
      for (const extra of [
        { currency: "USD" },
        { date: "2026-12-01" },
        { deliveryDate: "2026-12-01" },
        { accountNextInvoice: "2026-12-01" },
        { recurringInterval: "P0Y1M0W" },
        { interval: "weekly" },
        { interval: "P0Y1M0W" },
        { startDate: "01.12.2026" },
        { startDate: "2026-02-30" },
      ]) {
        expect(tool.input.safeParse({ ...args, ...extra }).success, JSON.stringify(extra)).toBe(
          false,
        );
      }
      expect(tool.input.safeParse({ ...args, interval: undefined }).success).toBe(false);
      expect(tool.input.safeParse({ ...args, startDate: undefined }).success).toBe(false);
    });
  });

  describe("after the save", () => {
    it("names the saved template when the read-back fails", async () => {
      const client = new FakeSevdeskClient(withRoutes(routes, notFound("/Invoice/2301")));
      const error = await executeWrite(tool, args, client).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(SevdeskError);
      expect((error as SevdeskError).completedWrites).toEqual([
        { objectName: "Invoice", id: "2301" },
      ]);
      expect(client.writes()).toHaveLength(1);
    });

    it("says that a template may exist when the answer has no id", async () => {
      const client = new FakeSevdeskClient(
        withRoutes(routes, {
          method: "POST",
          path: "/Invoice/Factory/saveInvoice",
          response: { body: { objects: { invoice: null } } },
        }),
      );
      await expect(executeWrite(tool, args, client)).rejects.toMatchObject({
        kind: "unexpected_response",
        message:
          "sevDesk accepted the request, but its answer did not contain the template's id, so it " +
          "could not be read back. A recurring invoice template may exist now: look for it with " +
          "sevdesk_invoices_list (type recurring) or in sevDesk under Abo-Rechnungen, and delete " +
          "or deactivate it there before repeating the call.",
      });
      // Never retried.
      expect(client.writes()).toHaveLength(1);
    });

    it("passes a failed save through without a second attempt", async () => {
      const failure = new SevdeskError({ kind: "timeout", message: "No answer." });
      const client = new FakeSevdeskClient(
        withRoutes(routes, {
          method: "POST",
          path: "/Invoice/Factory/saveInvoice",
          response: { error: failure },
        }),
      );
      await expect(executeWrite(tool, args, client)).rejects.toBe(failure);
      expect(client.writes()).toHaveLength(1);
    });
  });
});
