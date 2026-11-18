import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TEMPLATE_SETTINGS_EMBED } from "../../../../src/domain/recurring/schedule.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { tierScopedClient } from "../../../../src/sevdesk/scoped-client.js";
import { invoiceCreateRecurringTool as tool } from "../../../../src/tools/invoices/recurring-create.js";
import { ACCOUNT_RECURRING_INVOICES } from "../../../../src/tools/types.js";
import { allEnabledConfig } from "../../../helpers/config.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { notFound, TIMESTAMPS, unknownRegimeRoute, withRoutes } from "../drafts/routes.js";
import {
  recurringCreateArgs as args,
  recurringCreateRoutes as routes,
  SETTINGS_NEVER_SET,
  SETTINGS_ON,
  settingsReadRoute,
  templateRow,
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
    propertyAutoGenerateRecurringInvoice: true,
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

  describe("automatic generation (D-132)", () => {
    it("is on by default and sent as true, the same as asking for it", async () => {
      const byDefault = await prepare(args);
      const asked = await prepare({ ...args, autoGenerate: true });
      expect(byDefault.plan.state.body.invoice.propertyAutoGenerateRecurringInvoice).toBe(true);
      expect(asked.plan).toEqual(byDefault.plan);
    });

    it("is left out when off: a template saved without it reads null, which is off", async () => {
      const { plan } = await prepare({ ...args, autoGenerate: false });
      expect(plan.state.body.invoice).not.toHaveProperty("propertyAutoGenerateRecurringInvoice");
      const { propertyAutoGenerateRecurringInvoice: _on, ...withoutSwitch } = expectedBody.invoice;
      expect(plan.state.body).toEqual({ ...expectedBody, invoice: withoutSwitch });
    });

    it("is part of the approval: on and off bind different bodies", async () => {
      const on = await prepare(args);
      const off = await prepare({ ...args, autoGenerate: false });
      expect(off.plan.binding).not.toBe(on.plan.binding);
    });

    it("is a boolean, nothing else", () => {
      for (const value of ["1", "0", 1, 0, null]) {
        expect(tool.input.safeParse({ ...args, autoGenerate: value }).success, String(value)).toBe(
          false,
        );
      }
    });

    it("is stated as a fact, with what it means on a run date, in both languages", async () => {
      const on = await prepare(args);
      const off = await prepare({ ...args, autoGenerate: false });
      const fact = (plan: typeof on.plan, label: string, lang: "en" | "de" = "en") =>
        (lang === "de" ? plan.previewDe : plan.preview).facts.find((f) => f.label === label)?.value;
      const label = "Automatic generation (Automatische Generierung)";
      expect(fact(on.plan, label)).toBe("on (sevDesk creates a draft invoice on every run date)");
      expect(fact(off.plan, label)).toBe("off (sevDesk creates nothing by itself)");
      expect(fact(on.plan, "Automatische Generierung", "de")).toBe(
        "an (sevDesk erzeugt an jedem Ausführungstag einen Rechnungsentwurf)",
      );
      expect(fact(off.plan, "Automatische Generierung", "de")).toBe(
        "aus (sevDesk erzeugt von selbst nichts)",
      );
      expect(off.plan.preview.warnings[0]).toBe(
        "Automatic generation is off: sevDesk creates nothing from this template by itself, on " +
          "no run date, until someone switches automatic generation on for it in the sevDesk " +
          'web app or clicks "Rechnung erzeugen" there.',
      );
      expect(off.plan.previewDe.warnings[0]).toBe(
        "Die automatische Generierung ist aus: sevDesk erzeugt aus dieser Vorlage von selbst " +
          "nichts, an keinem Ausführungstag, bis jemand sie in der sevDesk-Web-App für die " +
          "Vorlage einschaltet oder dort auf „Rechnung erzeugen“ klickt.",
      );
    });

    it("warns that a first run today makes the first draft at once, only when on", async () => {
      const today = { ...args, startDate: "2026-11-17" };
      const on = await prepare(today);
      const off = await prepare({ ...today, autoGenerate: false });
      expect(on.plan.preview.warnings[3]).toBe(
        "The first run is today, so it is due at once: sevDesk creates the first draft within " +
          "about a minute of saving the template.",
      );
      expect(on.plan.previewDe.warnings[3]).toBe(
        "Die erste Ausführung ist heute und damit sofort fällig: sevDesk erzeugt den ersten " +
          "Entwurf etwa eine Minute nach dem Speichern der Vorlage.",
      );
      expect(off.plan.preview.warnings).toHaveLength(2);
      expect(off.plan.previewDe.warnings).toHaveLength(2);
    });
  });

  it("previews customer, schedule, texts, positions and totals in English", async () => {
    const { plan } = await prepare({
      ...args,
      timeToPay: 14,
      headText: "<p>Ihr Wartungsvertrag</p>",
      footText: "Zahlbar ohne Abzug.",
    });
    expect(plan.preview.action).toBe(
      "Create a recurring invoice template (Abo-Rechnung) for contact 1001: " +
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
      { label: "End", value: "none (the template runs until it is ended)" },
      {
        label: "Automatic generation (Automatische Generierung)",
        value: "on (sevDesk creates a draft invoice on every run date)",
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
      "Automatic generation is on: on every run date, within about a minute after 00:00 (Berlin " +
        "time), sevDesk creates a draft invoice from this template by itself, with these " +
        "positions and texts plus a line in the head text that names the billing period (the " +
        "run date to the day before the next run). sevDesk neither finalizes nor sends the " +
        "draft, and its number is provisional (several drafts can show the same number until " +
        "each is finalized): a person must still finalize and send every draft.",
      "This server never switches on automatic sending (Automatisches Versenden). If someone " +
        "switches it on for the template in the sevDesk web app, sevDesk finalizes every invoice " +
        "it creates with its final number, e-mails it with the PDF to the customer and enshrines " +
        "it (festgeschrieben) within about two minutes of the run time, before anyone has seen it.",
      "To change the template later, also to switch automatic generation on or off, use " +
        "sevdesk_invoice_update_recurring; to end it, sevdesk_invoice_end_recurring. A template " +
        "is deleted only in the sevDesk web app (Abo-Rechnungen).",
    ]);
  });

  it("says the same in German, in the same order", async () => {
    const { plan } = await prepare({ ...args, endDate: "2027-02-15" });
    expect(plan.previewDe.action).toBe(
      "Abo-Rechnung (Vorlage für wiederkehrende Rechnungen) für Kontakt 1001 anlegen: 65,45 EUR " +
        "brutto je Rechnung, monatlich ab 01.12.2026 bis 15.02.2027.",
    );
    expect(plan.previewDe.facts.map((fact) => fact.label)).toEqual([
      "Kunde",
      "Anschrift auf den Rechnungen",
      "Intervall",
      "Erste Ausführung",
      "Folgende Ausführungen",
      "Ende",
      "Automatische Generierung",
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
    expect(value("Ende")).toBe("15.02.2027 (bis dahin 3 Ausführungen, die erste eingeschlossen)");
    expect(value("Position 1")).toBe("Beratung: 3 × 10,00 EUR netto, 19 % USt. → netto 30,00 EUR");
    expect(value("Summe je Rechnung")).toBe("netto 55,00 EUR, USt. 10,45 EUR, brutto 65,45 EUR");
    expect(plan.previewDe.warnings).toHaveLength(plan.preview.warnings.length);
    expect(plan.previewDe.warnings[0]).toBe(
      "Die automatische Generierung ist an: An jedem Ausführungstag erzeugt sevDesk etwa eine " +
        "Minute nach 0 Uhr (Berliner Zeit) selbst einen Rechnungsentwurf aus dieser Vorlage, mit " +
        "diesen Positionen und Texten und einer Zeile im Kopftext, die den Abrechnungszeitraum " +
        "nennt (vom Ausführungstag bis zum Tag vor der nächsten Ausführung). sevDesk stellt den " +
        "Entwurf weder fertig noch versendet ihn, und seine Nummer ist vorläufig (mehrere " +
        "Entwürfe können dieselbe Nummer zeigen, bis jeder fertiggestellt ist): Jeden Entwurf " +
        "muss noch jemand fertigstellen und versenden.",
    );
    expect(plan.preview.facts.find((f) => f.label === "End")?.value).toBe(
      "2027-02-15 (3 runs up to then, the first included)",
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
      "The first run is today, so it is due at once: sevDesk creates the first draft within " +
        "about a minute of saving the template.",
      "A run falls on the end date itself (2027-01-17); whether sevDesk still runs the template " +
        "on its end date is not recorded.",
    ]);
    expect(plan.previewDe.warnings.slice(3)).toEqual([
      "Die erste Ausführung ist heute und damit sofort fällig: sevDesk erzeugt den ersten " +
        "Entwurf etwa eine Minute nach dem Speichern der Vorlage.",
      "Eine Ausführung fällt genau auf das Enddatum (17.01.2027); ob sevDesk die Vorlage am " +
        "Enddatum selbst noch ausführt, ist nicht erfasst.",
    ]);
    expect(plan.preview.facts.find((f) => f.label === "Following runs")?.value).toBe(
      "2026-12-17, 2027-01-17",
    );
  });

  it("counts a run on the end date as one that may not happen, in both languages", async () => {
    const fact = (plan: Awaited<ReturnType<typeof prepare>>["plan"], lang: "en" | "de") =>
      (lang === "de" ? plan.previewDe : plan.preview).facts.find(
        (f) => f.label === (lang === "de" ? "Ende" : "End"),
      )?.value;
    // Monthly from 2026-12-01 to 2027-12-01: the 13th run falls on the end date.
    const year = await prepare({ ...args, endDate: "2027-12-01" });
    expect(fact(year.plan, "en")).toBe(
      "2027-12-01 (12 or 13 runs up to then, the first included: 13 if sevDesk still runs the " +
        "template on its end date)",
    );
    expect(fact(year.plan, "de")).toBe(
      "01.12.2027 (bis dahin 12 oder 13 Ausführungen, die erste eingeschlossen: 13, wenn " +
        "sevDesk die Vorlage am Enddatum noch ausführt)",
    );
    // The fact and the warning that the run on the end date is not recorded keep their places.
    expect(year.plan.preview.facts.map((f) => f.label).indexOf("End")).toBe(5);
    expect(year.plan.previewDe.facts.map((f) => f.label).indexOf("Ende")).toBe(5);
    expect(year.plan.preview.warnings.at(-1)).toBe(
      "A run falls on the end date itself (2027-12-01); whether sevDesk still runs the template " +
        "on its end date is not recorded.",
    );
    expect(year.plan.previewDe.warnings.at(-1)).toBe(
      "Eine Ausführung fällt genau auf das Enddatum (01.12.2027); ob sevDesk die Vorlage am " +
        "Enddatum selbst noch ausführt, ist nicht erfasst.",
    );
    // The end on the start date: the only run is the one on the end date.
    const single = await prepare({ ...args, endDate: "2026-12-01" });
    expect(fact(single.plan, "en")).toBe(
      "2026-12-01 (0 or 1 run up to then: 1 if sevDesk still runs the template on its end date)",
    );
    expect(fact(single.plan, "de")).toBe(
      "01.12.2026 (bis dahin 0 oder 1 Ausführung: 1, wenn sevDesk die Vorlage am Enddatum noch " +
        "ausführt)",
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
      every: "every 1 month",
      startDate: "2026-12-01",
      nextRun: "2026-12-01",
      autoGenerate: "on",
      autoSendConfigured: false,
    });
    expect(output.data.notes).toBeUndefined();
    expect(output.summary).toBe(
      "Created recurring invoice template 2301 (monthly from 2026-12-01, gross 65.45 EUR per " +
        "invoice, automatic generation on).",
    );
    // The schedule and the switches come from the raw record, read with the settings embed.
    expect(client.callsTo("/Invoice/2301").map((call) => call.query["embed"])).toEqual(
      expect.arrayContaining(["contact", TEMPLATE_SETTINGS_EMBED]),
    );
  });

  it("says where sevDesk stored another schedule, type, status or total than was sent", async () => {
    const changes = {
      invoiceType: "RE",
      status: "200",
      sumGross: "70",
      accountStartDate: "2027-01-01T00:00:00+01:00",
      accountNextInvoice: "2027-01-01T00:00:00+01:00",
    };
    const client = new FakeSevdeskClient(
      withRoutes(
        routes,
        {
          path: "/Invoice/2301",
          query: { embed: "contact" },
          response: { body: { objects: [templateRow(changes)] } },
        },
        settingsReadRoute(templateRow({ ...changes, ...SETTINGS_ON })),
      ),
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

  it("notes nothing when sevDesk made the first run before the read-back (D-111)", async () => {
    // A first run today: sevDesk generates the first draft 30–40 s after the save, so a slow
    // read-back finds the next run one interval on and the last run set.
    const generated = {
      accountStartDate: "2026-11-17T00:00:00+01:00",
      accountNextInvoice: "2026-12-17T00:00:00+01:00",
      accountLastInvoice: "2026-11-17T12:00:41+01:00",
    };
    const client = new FakeSevdeskClient(
      withRoutes(routes, settingsReadRoute(templateRow({ ...generated, ...SETTINGS_ON }))),
    );
    const { output } = await executeWrite(tool, { ...args, startDate: "2026-11-17" }, client);
    expect(output.data.schedule).toMatchObject({
      startDate: "2026-11-17",
      nextRun: "2026-12-17",
      lastRun: "2026-11-17",
    });
    expect(output.data.notes).toBeUndefined();
    expect(output.summary).not.toContain("See notes");
  });

  describe("compares automatic generation and sending as stored with what was sent (D-132)", () => {
    const check = "Check the template in the sevDesk web app before its first run.";
    const offNote =
      "sevDesk stored automatic generation (Automatische Generierung) as off, not on as sent, so " +
      "it creates nothing from the template by itself. Switch it on for the template in the " +
      "sevDesk web app.";
    const onNote =
      "sevDesk stored automatic generation (Automatische Generierung) as on although it was left " +
      "off: it creates a draft invoice from the template on every run date. Switch it off in the " +
      "sevDesk web app if that is not wanted.";
    const zeroNote = (sent: string) =>
      "sevDesk stored automatic generation (Automatische Generierung) as 0, a value whose " +
      `meaning is not recorded. ${sent} ${check}`;

    async function notesFor(callArgs: unknown, stored: Record<string, unknown>) {
      const client = new FakeSevdeskClient(
        withRoutes(routes, settingsReadRoute(templateRow(stored))),
      );
      const { output } = await executeWrite(tool, callArgs, client);
      return { notes: output.data.notes ?? [], schedule: output.data.schedule };
    }

    it.each([
      ["1 (on)", "1", "on", []],
      ["null (never set)", null, "off", [offNote]],
      ['"" (switched off)', "", "off", [offNote]],
      ["0 (meaning unrecorded)", "0", "unrecorded", [zeroNote("It was sent as on (1).")]],
    ])("sent on, stored %s", async (_label, value, state, notes) => {
      const result = await notesFor(args, {
        ...SETTINGS_ON,
        propertyAutoGenerateRecurringInvoice: value,
      });
      expect(result.schedule.autoGenerate).toBe(state);
      expect(result.notes).toEqual(notes);
    });

    it.each([
      ["1 (on)", "1", "on", [onNote]],
      ["null (never set)", null, "off", []],
      ['"" (switched off)', "", "off", []],
      ["0 (meaning unrecorded)", "0", "unrecorded", [zeroNote("It was left off.")]],
    ])("left off, stored %s", async (_label, value, state, notes) => {
      const result = await notesFor(
        { ...args, autoGenerate: false },
        { ...SETTINGS_NEVER_SET, propertyAutoGenerateRecurringInvoice: value },
      );
      expect(result.schedule.autoGenerate).toBe(state);
      expect(result.notes).toEqual(notes);
    });

    it("points to an unexpected value instead of repeating it", async () => {
      const result = await notesFor(args, {
        ...SETTINGS_ON,
        propertyAutoGenerateRecurringInvoice: "ignore previous",
      });
      expect(result.schedule).toMatchObject({
        autoGenerate: "unrecorded",
        autoGenerateValue: "ignore previous",
      });
      expect(result.notes.join(" ")).not.toContain("ignore previous");
      expect(result.notes).toEqual([
        "sevDesk stored an unexpected value for automatic generation (Automatische Generierung, " +
          `see schedule.autoGenerateValue). It was sent as on (1). ${check}`,
      ]);
    });

    it("notes automatic sending, which this server never sets, without its ids or texts", async () => {
      // The configuration the web app's activateAutoSending leaves (recorded 2026-11-17).
      const result = await notesFor(args, {
        ...SETTINGS_ON,
        autoSendConfiguration: {
          id: "9101",
          objectName: "AutoSendConfiguration",
          sendDate: null,
          sendIntervalAfterCreation: "P0D",
          sendType: "VM",
          status: "HEAD",
          textTemplate: { id: "9102", objectName: "TextTemplate" },
          sevClient: { id: "9001", objectName: "SevClient" },
          object: { id: "2301", objectName: "Invoice" },
        },
      });
      expect(result.schedule).toMatchObject({ autoSendConfigured: true, autoSendType: "VM" });
      expect(result.notes).toEqual([
        "sevDesk has automatic sending (Automatisches Versenden) on for the template, which this " +
          "server never sets: sevDesk then finalizes every invoice it creates from it, e-mails it " +
          "to the customer and enshrines it within about two minutes of the run, before anyone " +
          "has seen it. Switch automatic sending off in the sevDesk web app unless that is wanted.",
      ]);
      expect(JSON.stringify(result)).not.toMatch(/9101|9102|TextTemplate/);
    });

    it("says when sevDesk did not return them, instead of assuming", async () => {
      const result = await notesFor(args, {});
      expect(result.schedule).not.toHaveProperty("autoGenerate");
      expect(result.schedule).not.toHaveProperty("autoSendConfigured");
      expect(result.notes).toEqual([
        `sevDesk did not return automatic generation (Automatische Generierung), so it could not be checked. ${check}`,
        `sevDesk did not return automatic sending (Automatisches Versenden), so it could not be checked. ${check}`,
      ]);
    });
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
        { propertyAutoGenerateRecurringInvoice: true },
        { autoSendConfiguration: { sendType: "VM" } },
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

  describe("a plan whose day ended before the save", () => {
    /**
     * Prepares at 23:59 Berlin time on 2026-11-17 and runs `execute` with that plan at 00:01 the
     * next day, as when midnight passes between the last preparation and the save.
     */
    async function saveAfterMidnight(callArgs: Record<string, unknown>) {
      vi.setSystemTime(new Date("2026-11-17T23:59:00+01:00"));
      const client = new FakeSevdeskClient(routes);
      const plan = await prepareWrite(tool, callArgs, client);
      vi.setSystemTime(new Date("2026-11-18T00:01:00+01:00"));
      const error = await tool
        .execute(tool.input.parse(callArgs), plan, {
          client: tierScopedClient(client, tool.tier),
          config: allEnabledConfig(),
          signal: new AbortController().signal,
          progress: () => Promise.resolve(),
          files: {} as never,
        })
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      return { client, plan, error };
    }
    const changed =
      "Nothing was sent: the date in Berlin changed from 2026-11-17 to 2026-11-18 after the " +
      "preview was made.";

    it("refuses a first run that became due at once, which the preview did not warn of", async () => {
      const { client, plan, error } = await saveAfterMidnight({ ...args, startDate: "2026-11-18" });
      expect(plan.preview.warnings).toHaveLength(3);
      expect(error).toBeInstanceOf(SevdeskError);
      expect(error).toMatchObject({
        kind: "validation",
        message:
          `${changed} The first run on 2026-11-18 is now today, so sevDesk would create the ` +
          "first draft within about a minute of the save, which the preview did not say. Call " +
          "the tool again for a new preview.",
      });
      expect(client.writes()).toEqual([]);
    });

    it("refuses a start that is now in the past, which sevDesk would catch up", async () => {
      const { client, error } = await saveAfterMidnight({ ...args, startDate: "2026-11-17" });
      expect(error).toBeInstanceOf(SevdeskError);
      const { kind, message } = error as SevdeskError;
      expect(kind).toBe("validation");
      expect(message.startsWith(changed)).toBe(true);
      expect(message).toContain(
        "The start date 2026-11-17 is in the past (today is 2026-11-18 in Berlin).",
      );
      expect(message.endsWith("Call the tool again for a new preview.")).toBe(true);
      expect(client.writes()).toEqual([]);
    });

    it("saves when the new day changes nothing the preview said", async () => {
      const later = await saveAfterMidnight(args);
      expect(later.error).toBeUndefined();
      expect(later.client.writes()).toHaveLength(1);
      // Without automatic generation a first run today creates nothing, warned or not.
      const off = await saveAfterMidnight({
        ...args,
        startDate: "2026-11-18",
        autoGenerate: false,
      });
      expect(off.error).toBeUndefined();
      expect(off.client.writes()).toHaveLength(1);
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
