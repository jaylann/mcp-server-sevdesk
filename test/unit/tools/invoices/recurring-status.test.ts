import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RUN_DATE_BEHAVIOUR,
  RUN_DATE_ON_AT_STORED_TIME,
} from "../../../../src/domain/recurring/run-date.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import {
  invoiceEndRecurringTool as endTool,
  invoiceReactivateRecurringTool as reactivateTool,
} from "../../../../src/tools/invoices/recurring-status.js";
import { ACCOUNT_RECURRING_INVOICES } from "../../../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient } from "../../../helpers/fake-client.js";
import { executeWrite, prepareWrite } from "../../../helpers/write-tools.js";
import { StagedClient } from "../lifecycle/helpers.js";
import { storedDate, templateChangeRoutes, templateRow } from "./recurring-manage-routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-17T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

type StatusTool = typeof endTool;

async function refusal(tool: StatusTool, table: readonly FakeRoute[]): Promise<string> {
  const client = new FakeSevdeskClient(table);
  const error = await prepareWrite(tool, { id: 2301 }, client).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect((error as SevdeskError).kind).toBe("validation");
  expect(client.writes()).toEqual([]);
  return (error as SevdeskError).message;
}

const ended = templateRow({ status: "50" });
const fact = (facts: readonly { label: string; value: string }[], label: string) =>
  facts.find((f) => f.label === label)?.value;

describe.each([endTool, reactivateTool])("$name", (tool) => {
  it("is a commit tool: destructive, idempotent, closed world, locked per account and template", () => {
    expect(tool.tier).toBe("commit");
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool.locks?.(tool.input.parse({ id: 2301 }))).toEqual([
      ACCOUNT_RECURRING_INVOICES,
      { objectName: "Invoice", id: "2301" },
    ]);
  });

  it("refuses an invoice that is not a template", async () => {
    expect(await refusal(tool, templateChangeRoutes(templateRow({ invoiceType: "RE" })))).toBe(
      `Invoice 2301 is a normal invoice (RE), not a recurring invoice template; ${tool.name} ` +
        "works only on recurring invoice templates (WKR, Abo-Rechnung). Find recurring invoice " +
        "templates with sevdesk_invoices_list (type recurring).",
    );
  });

  it("refuses unknown arguments", () => {
    expect(tool.input.safeParse({ id: 2301, status: 50 }).success).toBe(false);
  });
});

describe("sevdesk_invoice_end_recurring", () => {
  it("sends status 50 and nothing else (D-112)", async () => {
    const client = new FakeSevdeskClient(templateChangeRoutes());
    const plan = await prepareWrite(endTool, { id: 2301 }, client);
    expect(client.writes()).toEqual([]);
    expect(plan.state.body).toEqual({
      invoice: { id: 2301, objectName: "Invoice", mapAll: true, status: "50" },
      invoicePosSave: null,
      invoicePosDelete: null,
    });
    expect(plan.binding).toMatch(/^[0-9a-f]{64}$/);
  });

  it("previews what ends and what stays, in English and German", async () => {
    const plan = await prepareWrite(
      endTool,
      { id: 2301 },
      new FakeSevdeskClient(templateChangeRoutes()),
    );
    expect(plan.preview.action).toBe(
      "End recurring invoice template 2301 (Abo-Rechnung) for Musterfirma GmbH (contact 1001): " +
        "sevDesk creates no further invoice from it.",
    );
    expect(plan.preview.facts).toEqual([
      { label: "Template", value: "2301 (recurring invoice template, status 100)" },
      { label: "Customer", value: "Musterfirma GmbH (contact 1001)" },
      { label: "Title (Betreff)", value: "Rechnung" },
      { label: "Interval", value: "monthly, every month on day 1 (P0Y1M0W)" },
      { label: "Automatic generation (Automatische Generierung)", value: "on" },
      { label: "Next run", value: "2026-12-01, no longer happens once the template is ended" },
      { label: "End", value: "none" },
      { label: "Last run", value: "none yet" },
      { label: "Total per invoice", value: "net 55.00 EUR, tax 10.45 EUR, gross 65.45 EUR" },
    ]);
    expect(plan.preview.warnings).toEqual([
      "Invoices sevDesk already created from this template stay as they are: ending it does " +
        "not cancel, change or delete any of them (a wrong one is cancelled with " +
        "sevdesk_invoice_cancel).",
      "An ended template generates nothing, even with automatic generation on (recorded). It " +
        "keeps its automatic generation as it is, for a later reactivation.",
      "The template is kept with its positions and schedule: " +
        "sevdesk_invoice_reactivate_recurring starts it again. A template is deleted only in the " +
        "sevDesk web app (Abo-Rechnungen).",
    ]);
    expect(plan.previewDe.action).toBe(
      "Abo-Rechnung 2301 für Musterfirma GmbH (Kontakt 1001) beenden: sevDesk erzeugt aus ihr " +
        "keine Rechnung mehr.",
    );
    expect(fact(plan.previewDe.facts, "Nächste Ausführung")).toBe(
      "01.12.2026, entfällt mit dem Beenden",
    );
    expect(plan.previewDe.warnings).toHaveLength(3);
  });

  it("ends a template with automatic sending on, saying that it stops the e-mails", async () => {
    const sending = templateRow({ autoSendConfiguration: { id: "77", sendType: "VM" } });
    const plan = await prepareWrite(
      endTool,
      { id: 2301 },
      new FakeSevdeskClient(templateChangeRoutes(sending)),
    );
    expect(plan.state.body.invoice).toEqual({
      id: 2301,
      objectName: "Invoice",
      mapAll: true,
      status: "50",
    });
    expect(plan.preview.warnings).toContainEqual(
      expect.stringMatching(
        /^Automatic sending \(Automatisches Versenden\) is on for this template: ending it stops/,
      ),
    );
    expect(plan.previewDe.warnings).toHaveLength(plan.preview.warnings.length);
  });

  it("ends a template made in the web app (an interval this server does not offer)", async () => {
    const at = "2026-12-01T11:08:00+01:00";
    const web = templateRow({
      accountIntervall: "P0Y0M1W",
      accountStartDate: at,
      accountNextInvoice: at,
      autoSendConfiguration: undefined,
      propertyAutoGenerateRecurringInvoice: undefined,
    });
    const plan = await prepareWrite(
      endTool,
      { id: 2301 },
      new FakeSevdeskClient(templateChangeRoutes(web)),
    );
    expect(fact(plan.preview.facts, "Interval")).toBe(
      "every 1 week (P0Y0M1W; not an interval this server offers)",
    );
    expect(fact(plan.preview.facts, "Automatic generation (Automatische Generierung)")).toBe(
      "not returned by sevDesk",
    );
    expect(plan.preview.facts.map((f) => f.value).join(" ")).not.toMatch(/00:00/);
  });

  it("warns when the next run is today", async () => {
    const today = storedDate("2026-11-17");
    const plan = await prepareWrite(
      endTool,
      { id: 2301 },
      new FakeSevdeskClient(templateChangeRoutes(templateRow({ accountNextInvoice: today }))),
    );
    expect(plan.preview.warnings.at(-1)).toBe(
      "The next run is today: if sevDesk has already created today's invoice, ending the " +
        "template does not undo it.",
    );
  });

  it("refuses a template that is ended already", async () => {
    expect(await refusal(endTool, templateChangeRoutes(ended))).toBe(
      "Recurring invoice template 2301 is ended already (status 50); nothing changes. " +
        "sevdesk_invoice_reactivate_recurring starts it again.",
    );
  });

  it("saves once with the commit tier and reads the ended template back", async () => {
    const client = new StagedClient(templateChangeRoutes(), templateChangeRoutes(ended));
    const { output } = await executeWrite(endTool, { id: 2301 }, client);
    expect(client.writes()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/Invoice/Factory/saveInvoice",
        tier: "commit",
        body: {
          invoice: { id: 2301, objectName: "Invoice", mapAll: true, status: "50" },
          invoicePosSave: null,
          invoicePosDelete: null,
        },
      }),
    ]);
    expect(output.data.schedule).toMatchObject({ nextRun: "2026-12-01", ended: true });
    expect(output.data.notes).toBeUndefined();
    expect(output.summary).toBe("Ended recurring invoice template 2301 (status 50).");
  });

  it("says when sevDesk kept the status or moved the schedule", async () => {
    const moved = templateRow({ accountNextInvoice: storedDate("2027-01-01") });
    const client = new StagedClient(templateChangeRoutes(), templateChangeRoutes(moved));
    const { output } = await executeWrite(endTool, { id: 2301 }, client);
    expect(output.data.notes).toEqual([
      "sevDesk stored the template with status 100 instead of 50. Check it in sevDesk.",
      "sevDesk stored the next run 2027-01-01 instead of 2026-12-01. Check the template in " +
        "sevDesk before its next run.",
    ]);
  });
});

describe("sevdesk_invoice_reactivate_recurring", () => {
  it("sends the status of a new template and nothing else", async () => {
    const plan = await prepareWrite(
      reactivateTool,
      { id: 2301 },
      new FakeSevdeskClient(templateChangeRoutes(ended)),
    );
    expect(plan.state.body).toEqual({
      invoice: { id: 2301, objectName: "Invoice", mapAll: true, status: "100" },
      invoicePosSave: null,
      invoicePosDelete: null,
    });
  });

  it("previews that sevDesk generates drafts again (generation on), with the run dates", async () => {
    const plan = await prepareWrite(
      reactivateTool,
      { id: 2301 },
      new FakeSevdeskClient(
        templateChangeRoutes(
          templateRow({ status: "50", accountEndDate: storedDate("2027-02-01") }),
        ),
      ),
    );
    expect(plan.preview.action).toBe(
      "Reactivate recurring invoice template 2301 (Abo-Rechnung) for Musterfirma GmbH (contact " +
        "1001): sevDesk generates draft invoices from it again, 65.45 EUR gross each, the next " +
        "on 2026-12-01.",
    );
    expect(fact(plan.preview.facts, "Automatic generation (Automatische Generierung)")).toBe("on");
    expect(fact(plan.preview.facts, "Next run")).toBe("2026-12-01");
    expect(fact(plan.preview.facts, "Following runs")).toBe("2027-01-01, 2027-02-01");
    expect(fact(plan.preview.facts, "End")).toBe(
      "2027-02-01 (3 runs up to then, the first included)",
    );
    expect(plan.preview.warnings).toEqual([
      expect.stringMatching(/^Once reactivated, sevDesk again creates a draft invoice/),
      RUN_DATE_BEHAVIOUR.on.en,
      RUN_DATE_BEHAVIOUR.autoSending.en,
      expect.stringMatching(/^A run falls on the end date itself \(2027-02-01\)/),
    ]);
    expect(plan.previewDe.action).toBe(
      "Abo-Rechnung 2301 für Musterfirma GmbH (Kontakt 1001) wieder aktivieren: sevDesk erzeugt " +
        "aus ihr wieder Rechnungsentwürfe über 65,45 EUR brutto, den nächsten am 01.12.2026.",
    );
    expect(plan.previewDe.warnings).toHaveLength(plan.preview.warnings.length);
  });

  it("says that a next run today is due at once", async () => {
    const today = storedDate("2026-11-17");
    const plan = await prepareWrite(
      reactivateTool,
      { id: 2301 },
      new FakeSevdeskClient(
        templateChangeRoutes(templateRow({ status: "50", accountNextInvoice: today })),
      ),
    );
    expect(plan.preview.warnings).toContain(
      "The next run is today, so it is due at once: sevDesk creates a draft within about a " +
        "minute of the reactivation.",
    );
  });

  it("with generation off: reactivating alone generates nothing, also with a past next run", async () => {
    const past = storedDate("2026-11-01");
    const off = templateRow({
      status: "50",
      propertyAutoGenerateRecurringInvoice: null,
      accountNextInvoice: past,
    });
    const plan = await prepareWrite(
      reactivateTool,
      { id: 2301 },
      new FakeSevdeskClient(templateChangeRoutes(off)),
    );
    expect(plan.preview.action).toBe(
      "Reactivate recurring invoice template 2301 (Abo-Rechnung) for Musterfirma GmbH (contact " +
        "1001); with automatic generation off, sevDesk creates nothing from it by itself.",
    );
    expect(plan.preview.warnings).toEqual([
      expect.stringMatching(
        /^Automatic generation is off for this template, so reactivating it alone generates nothing\./,
      ),
      "The next run (2026-11-01) lies before today: before automatic generation is switched " +
        "on, the template needs a new start date, or sevDesk would catch up the missed periods.",
    ]);
    expect(plan.previewDe.warnings).toHaveLength(2);
  });

  it("a template made in the web app: runs at its stored time, the later runs not listed", async () => {
    const at = "2026-12-01T11:08:00+01:00";
    const web = templateRow({
      status: "50",
      accountIntervall: "P0Y0M1W",
      accountStartDate: at,
      accountNextInvoice: at,
    });
    const plan = await prepareWrite(
      reactivateTool,
      { id: 2301 },
      new FakeSevdeskClient(templateChangeRoutes(web)),
    );
    expect(fact(plan.preview.facts, "Following runs")).toBe(
      "not computed: the stored interval is not one this server offers",
    );
    expect(plan.preview.warnings).toContain(RUN_DATE_ON_AT_STORED_TIME.en);
    expect(plan.preview.warnings).not.toContain(RUN_DATE_BEHAVIOUR.on.en);
    expect(plan.preview.warnings).toContain(
      "The stored interval is not one this server offers, so the runs after the next one are " +
        "not listed; check them in the sevDesk web app.",
    );
  });

  it("warns about a run day some months lack (a template from the web app)", async () => {
    const day31 = storedDate("2026-12-31");
    const plan = await prepareWrite(
      reactivateTool,
      { id: 2301 },
      new FakeSevdeskClient(
        templateChangeRoutes(templateRow({ status: "50", accountNextInvoice: day31 })),
      ),
    );
    expect(fact(plan.preview.facts, "Following runs")).toBe("2027-01-31, 2027-02-28, 2027-03-31");
    expect(plan.preview.warnings).toContain(
      "The runs fall on a day some months do not have; how sevDesk moves such a run is not " +
        "recorded. The dates listed assume the month's last day.",
    );
  });

  it.each([
    ["an active template", templateRow(), "is active already (status 100); nothing changes"],
    [
      "a next run in the past",
      templateRow({ status: "50", accountNextInvoice: storedDate("2026-11-01") }),
      "The next run of recurring invoice template 2301 is 2026-11-01, before today (2026-11-17 " +
        "in Berlin), and its automatic generation is on. Reactivated, sevDesk would catch up " +
        "and create a draft for every period since then, one a minute",
    ],
    [
      "no next run with generation on",
      templateRow({ status: "50", accountNextInvoice: null }),
      "has automatic generation on but no next run date",
    ],
    [
      "an end before the next run",
      templateRow({ status: "50", accountEndDate: storedDate("2026-11-30") }),
      "The end date 2026-11-30 of recurring invoice template 2301 is before its next run",
    ],
    [
      "automatic sending on",
      templateRow({ status: "50", autoSendConfiguration: { id: "77", sendType: "VM" } }),
      "sevdesk_invoice_end_recurring",
    ],
    [
      "settings sevDesk did not return",
      templateRow({ status: "50", autoSendConfiguration: undefined }),
      "could not be checked",
    ],
    [
      "a generation value whose meaning is not recorded",
      templateRow({ status: "50", propertyAutoGenerateRecurringInvoice: "2" }),
      "not recorded",
    ],
  ])("refuses %s", async (_label, row, message) => {
    expect(await refusal(reactivateTool, templateChangeRoutes(row))).toContain(message);
  });

  it("saves once and reads the active template back", async () => {
    const client = new StagedClient(templateChangeRoutes(ended), templateChangeRoutes());
    const { output } = await executeWrite(reactivateTool, { id: 2301 }, client);
    expect(client.writes()).toHaveLength(1);
    expect(output.data.schedule.ended).toBeUndefined();
    expect(output.data.notes).toBeUndefined();
    expect(output.summary).toBe("Reactivated recurring invoice template 2301 (status 100).");
  });
});
