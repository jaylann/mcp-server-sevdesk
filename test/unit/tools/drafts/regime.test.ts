/**
 * The draft tools follow the account's VAT regulation (`GET /SevClient`, smallSettlement): on a
 * Kleinunternehmer account the default tax rule is 11 and rules for regular VAT are refused
 * (sevDesk refused to finalize a rule-1 invoice there, 422 recorded 2026-11-07); on a regular
 * account rule 11 is refused; when the regime cannot be read, the old defaults apply with a
 * preview warning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UNKNOWN_REGIME_WARNING } from "../../../../src/domain/drafts/tax.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { creditNoteCreateDraftTool } from "../../../../src/tools/credit-notes/draft-create.js";
import { invoiceCreateDraftTool } from "../../../../src/tools/invoices/draft-create.js";
import { invoiceUpdateDraftTool } from "../../../../src/tools/invoices/draft-update.js";
import { orderCreateDraftTool } from "../../../../src/tools/orders/draft-create.js";
import { orderUpdateDraftTool } from "../../../../src/tools/orders/draft-update.js";
import type { AnyWriteToolDefinition } from "../../../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { prepareWrite } from "../../../helpers/write-tools.js";
import {
  creditNoteCreateArgs,
  creditNoteCreateRoutes,
  invoiceCreateArgs,
  invoiceCreateRoutes,
  invoiceUpdateRoutes,
  orderCreateArgs,
  orderCreateRoutes,
  orderUpdateRoutes,
  smallBusinessAccountRoute,
  unknownRegimeRoute,
  withRoutes,
} from "./routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

const SMALL = smallBusinessAccountRoute;

const zeroRated = [{ name: "Beratung", quantity: 2, unitPrice: "50.00" }];

const KLEINUNTERNEHMER_REFUSAL =
  "This sevDesk account uses the Kleinunternehmer regulation (§19 UStG), so tax rule 1 " +
  "(Umsatzsteuerpflichtige Umsätze) cannot be used: sevDesk refuses to finalize invoices with " +
  "it. Use tax rule 11 with 0 %: leave out taxRuleId (rule 11 is the default on this account) and " +
  "give the positions taxRate 0 or none.";

/** The positions of source invoice 1001, all at 0 %. */
function zeroRatedSourcePositions(): FakeRoute {
  const stored = loadFixture("invoices/invoice-positions-1001.json").body as {
    objects: Record<string, unknown>[];
  };
  return {
    path: "/InvoicePos",
    query: { "invoice[id]": 1001 },
    response: { body: { objects: stored.objects.map((row) => ({ ...row, taxRate: "0" })) } },
  };
}

/** The parts of a draft plan these tests look at. */
interface Prepared {
  readonly preview: { readonly warnings: readonly string[] };
  readonly state: { readonly body: Record<string, unknown> };
}

async function plan(tool: AnyWriteToolDefinition, args: unknown, routes: readonly FakeRoute[]) {
  const client = new FakeSevdeskClient(routes);
  const prepared = await prepareWrite(tool, args, client);
  expect(client.writes()).toEqual([]);
  return { client, plan: prepared as Prepared };
}

async function refusal(
  tool: AnyWriteToolDefinition,
  args: unknown,
  routes: readonly FakeRoute[],
): Promise<SevdeskError> {
  const client = new FakeSevdeskClient(routes);
  const error: unknown = await prepareWrite(tool, args, client).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(SevdeskError);
  expect(client.writes()).toEqual([]);
  return error as SevdeskError;
}

describe("Kleinunternehmer account (smallSettlement 1)", () => {
  it("defaults invoices to tax rule 11 with 0 % and smallSettlement", async () => {
    const { client, plan: prepared } = await plan(
      invoiceCreateDraftTool,
      { contactId: 1001, positions: zeroRated },
      withRoutes(invoiceCreateRoutes, SMALL),
    );
    expect(client.calls[0]?.path).toBe("/SevClient");
    expect(prepared.state.body["invoice"]).toMatchObject({
      taxRule: { id: 11, objectName: "TaxRule" },
      taxText: "Steuer nicht erhoben nach §19UStG",
      smallSettlement: true,
    });
    expect(prepared.state.body["invoicePosSave"]).toMatchObject([{ taxRate: 0 }]);
    expect(prepared.preview.warnings).toEqual([]);
  });

  it("defaults orders to tax rule 11 too", async () => {
    const { plan: prepared } = await plan(
      orderCreateDraftTool,
      { ...orderCreateArgs, positions: zeroRated },
      withRoutes(orderCreateRoutes, SMALL),
    );
    expect(prepared.state.body["order"]).toMatchObject({
      taxRule: { id: 11, objectName: "TaxRule" },
      smallSettlement: true,
    });
  });

  it("refuses tax rule 1 with an actionable message, before any other read", async () => {
    const client = new FakeSevdeskClient(withRoutes(invoiceCreateRoutes, SMALL));
    const error: unknown = await prepareWrite(
      invoiceCreateDraftTool,
      { ...invoiceCreateArgs, taxRuleId: 1 },
      client,
    ).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ kind: "validation", message: KLEINUNTERNEHMER_REFUSAL });
    expect(client.calls.map((call) => call.path)).toEqual(["/SevClient"]);
  });

  it("explains a VAT rate under the default rule with the account's regulation", async () => {
    const error = await refusal(
      invoiceCreateDraftTool,
      invoiceCreateArgs,
      withRoutes(invoiceCreateRoutes, SMALL),
    );
    expect(error.message).toBe(
      "Position 1 has a tax rate of 19 %, which tax rule 11 (Steuer nicht erhoben nach §19UStG) " +
        "does not allow. Tax rule 11 allows 0 %. This sevDesk account uses the Kleinunternehmer " +
        "regulation (§19 UStG): its documents show no VAT, so every position takes 0 %.",
    );
  });

  it("refuses other rules for regular VAT, naming rule 11", async () => {
    const error = await refusal(
      orderCreateDraftTool,
      { ...orderCreateArgs, taxRuleId: 3 },
      withRoutes(orderCreateRoutes, SMALL),
    );
    expect(error.message).toMatch(
      /^This sevDesk account uses the Kleinunternehmer regulation \(§19 UStG\), so tax rule 3 \(Innergemeinschaftliche Lieferungen\) cannot be used: sevDesk refuses to finalize orders with it\. Use tax rule 11 with 0 %/,
    );
  });

  it("gives provision credit notes tax rule 10 at 0 % and says it is unverified", async () => {
    const { plan: prepared } = await plan(
      creditNoteCreateDraftTool,
      {
        contactId: 1001,
        bookingCategory: "provision",
        positions: [{ name: "Provision Oktober", quantity: 1, unitPrice: 100 }],
      },
      withRoutes(creditNoteCreateRoutes, SMALL),
    );
    expect(prepared.state.body["creditNote"]).toMatchObject({
      taxRule: { id: 10, objectName: "TaxRule" },
      taxText: "Nicht vorsteuerabziehbare Aufwendungen",
      smallSettlement: true,
    });
    expect(prepared.state.body["creditNotePosSave"]).toMatchObject([{ taxRate: 0 }]);
    expect(prepared.preview.warnings).toContain(
      "On a Kleinunternehmer account provision credit notes take tax rule 10 or 13 at 0 % " +
        "(sevDesk names them when it refuses rule 9); saving one this way is not verified live " +
        "yet, so check the draft in sevDesk before finalizing.",
    );
  });

  it("refuses rule 9 for a provision credit note and names rules 10 and 13", async () => {
    const error = await refusal(
      creditNoteCreateDraftTool,
      {
        contactId: 1001,
        bookingCategory: "provision",
        taxRuleId: 9,
        positions: [{ name: "Provision", quantity: 1, unitPrice: 100, taxRate: 19 }],
      },
      withRoutes(creditNoteCreateRoutes, SMALL),
    );
    expect(error.message).toBe(
      "This sevDesk account uses the Kleinunternehmer regulation (§19 UStG), so tax rule 9 " +
        "(Vorsteuerabziehbare Aufwendungen) cannot be used: sevDesk refuses to finalize provision " +
        "credit notes on a Kleinunternehmer account with it. Use tax rule 10 or 13.",
    );
  });

  it("keeps the source invoice's rule for an underachievement credit note and explains the dead end", async () => {
    // The source invoice (no readable rule, 19 %) was issued under regular VAT: rule 1 stays the
    // default instead of silently becoming 11, and no Kleinunternehmer rule allows 19 %.
    const sourceRefusal =
      "This sevDesk account uses the Kleinunternehmer regulation (§19 UStG), so tax rule 1 " +
      "(Umsatzsteuerpflichtige Umsätze) cannot be used: sevDesk refuses to finalize credit notes " +
      "with it. An underachievement credit note must keep the rates of the invoice it reduces " +
      "(invoice 1001: 19 %), and no tax rule of this regulation allows them: the invoice was " +
      "issued under the other regulation. Correct it in the sevDesk web app or with your tax " +
      "advisor.";
    const error = await refusal(
      creditNoteCreateDraftTool,
      creditNoteCreateArgs,
      withRoutes(creditNoteCreateRoutes, SMALL),
    );
    expect(error.message).toBe(sourceRefusal);
    const explicit = await refusal(
      creditNoteCreateDraftTool,
      { ...creditNoteCreateArgs, taxRuleId: 1 },
      withRoutes(creditNoteCreateRoutes, SMALL),
    );
    expect(explicit.message).toBe(sourceRefusal);
    // Rule 11 fits the account but not the invoice's rate.
    const rule11 = await refusal(
      creditNoteCreateDraftTool,
      { ...creditNoteCreateArgs, taxRuleId: 11 },
      withRoutes(creditNoteCreateRoutes, SMALL),
    );
    expect(rule11.message).toBe(
      "Position 1 has no taxRate, and the only rate of the source invoice 1001 (19 %) is not " +
        "allowed by tax rule 11 (Steuer nicht erhoben nach §19UStG). Tax rule 11 allows 0 %. " +
        "This sevDesk account uses the Kleinunternehmer regulation (§19 UStG): its documents " +
        "show no VAT, so every position takes 0 %.",
    );
  });

  it("names rule 11 for an underachievement credit note on a 0 % invoice", async () => {
    const routes = withRoutes(creditNoteCreateRoutes, SMALL, zeroRatedSourcePositions());
    const error = await refusal(creditNoteCreateDraftTool, creditNoteCreateArgs, routes);
    expect(error.message).toBe(
      "This sevDesk account uses the Kleinunternehmer regulation (§19 UStG), so tax rule 1 " +
        "(Umsatzsteuerpflichtige Umsätze) cannot be used: sevDesk refuses to finalize credit " +
        "notes with it. Pass taxRuleId 11 (Steuer nicht erhoben nach §19UStG) instead: it allows " +
        "the rates of invoice 1001: 0 %.",
    );
    const { plan: prepared } = await plan(
      creditNoteCreateDraftTool,
      { ...creditNoteCreateArgs, taxRuleId: 11 },
      routes,
    );
    expect(prepared.state.body["creditNote"]).toMatchObject({
      taxRule: { id: 11, objectName: "TaxRule" },
      smallSettlement: true,
    });
  });

  it("refuses a new rule for regular VAT on an update", async () => {
    const error = await refusal(
      invoiceUpdateDraftTool,
      { id: 2102, taxRuleId: 1 },
      withRoutes(invoiceUpdateRoutes, SMALL),
    );
    expect(error.message).toBe(KLEINUNTERNEHMER_REFUSAL);
  });

  it("checks stored rates against rule 11 on an update with the account's hint", async () => {
    const error = await refusal(
      invoiceUpdateDraftTool,
      { id: 2102, taxRuleId: 11 },
      withRoutes(invoiceUpdateRoutes, SMALL),
    );
    expect(error.message).toMatch(
      /does not allow\. Tax rule 11 allows 0 %\. This sevDesk account uses the Kleinunternehmer regulation/,
    );
  });

  it("warns when an update keeps a stored rule that does not fit", async () => {
    const { plan: prepared } = await plan(
      invoiceUpdateDraftTool,
      { id: 2102, header: "Neu" },
      withRoutes(invoiceUpdateRoutes, SMALL),
    );
    expect(prepared.preview.warnings).toContain(
      "The draft keeps tax rule 1 (Umsatzsteuerpflichtige Umsätze), which does not fit this " +
        "account's VAT regulation (the Kleinunternehmer regulation (§19 UStG)): sevDesk will " +
        "refuse to finalize it. Pass taxRuleId 11 (Kleinunternehmer, §19 UStG) with 0 % rates to " +
        "fix it.",
    );
  });
});

describe("regular VAT account (smallSettlement 0)", () => {
  it("keeps tax rule 1 as the default without regime warnings", async () => {
    const { plan: prepared } = await plan(
      invoiceCreateDraftTool,
      invoiceCreateArgs,
      invoiceCreateRoutes,
    );
    expect(prepared.state.body["invoice"]).toMatchObject({
      taxRule: { id: 1, objectName: "TaxRule" },
      smallSettlement: false,
    });
    expect(prepared.preview.warnings).toEqual([]);
  });

  it("refuses tax rule 11 on a create and on an update", async () => {
    const regular =
      "This sevDesk account charges VAT (regular taxation, not the Kleinunternehmer regulation " +
      "of §19 UStG), so tax rule 11 (Steuer nicht erhoben nach §19UStG) cannot be used: sevDesk " +
      "refuses to finalize orders with it. Use tax rule 1 (Umsatzsteuerpflichtige Umsätze, 0, 7 " +
      "or 19 %; the default on this account) or another rule from sevdesk_reference_lookup " +
      "kind=tax_rules. If the account should use the Kleinunternehmer regulation, change that in " +
      "sevDesk's settings first.";
    const created = await refusal(
      orderCreateDraftTool,
      { ...orderCreateArgs, taxRuleId: 11, positions: zeroRated },
      orderCreateRoutes,
    );
    expect(created.message).toBe(regular);
    const updated = await refusal(
      orderUpdateDraftTool,
      { id: 3102, taxRuleId: 11 },
      orderUpdateRoutes,
    );
    expect(updated.message).toBe(regular);
  });

  it("warns when an update keeps a stored rule 11", async () => {
    const stored = loadFixture("drafts/order-3102-draft.json").body as {
      objects: Record<string, unknown>[];
    };
    const rule11: FakeRoute = {
      path: "/Order/3102",
      response: {
        body: { objects: [{ ...stored.objects[0], taxRule: { id: "11", objectName: "TaxRule" } }] },
      },
    };
    const { plan: prepared } = await plan(
      orderUpdateDraftTool,
      { id: 3102, header: "Neu" },
      withRoutes(orderUpdateRoutes, rule11),
    );
    expect(prepared.preview.warnings).toContain(
      "The draft keeps tax rule 11 (Steuer nicht erhoben nach §19UStG), which does not fit this " +
        "account's VAT regulation (regular VAT, not the Kleinunternehmer regulation): sevDesk " +
        "will refuse to finalize it. Pass taxRuleId 1 (Umsatzsteuerpflichtige Umsätze) or another " +
        "rule for regular VAT to fix it.",
    );
  });
});

describe("underachievement credit note on a regular account", () => {
  it("keeps a source invoice's rule 11 as the default and names rule 1 for its 0 %", async () => {
    const stored = loadFixture("invoices/invoice-1001.json").body as {
      objects: Record<string, unknown>[];
    };
    const kleinunternehmerInvoice: FakeRoute = {
      path: "/Invoice/1001",
      query: { embed: "contact" },
      response: {
        body: {
          objects: [{ ...stored.objects[0], taxRule: { id: "11", objectName: "TaxRule" } }],
        },
      },
    };
    const error = await refusal(
      creditNoteCreateDraftTool,
      creditNoteCreateArgs,
      withRoutes(creditNoteCreateRoutes, kleinunternehmerInvoice, zeroRatedSourcePositions()),
    );
    expect(error.message).toBe(
      "This sevDesk account charges VAT (regular taxation, not the Kleinunternehmer regulation of " +
        "§19 UStG), so tax rule 11 (Steuer nicht erhoben nach §19UStG) cannot be used: sevDesk " +
        "refuses to finalize credit notes with it. Pass taxRuleId 1 (Umsatzsteuerpflichtige " +
        "Umsätze) instead: it allows the rates of invoice 1001: 0 %.",
    );
  });
});

describe("regime unknown (GET /SevClient unreadable)", () => {
  it("falls back to tax rule 1 and says the rule was not checked", async () => {
    const { plan: prepared } = await plan(
      invoiceCreateDraftTool,
      invoiceCreateArgs,
      withRoutes(invoiceCreateRoutes, unknownRegimeRoute),
    );
    expect(prepared.state.body["invoice"]).toMatchObject({
      taxRule: { id: 1, objectName: "TaxRule" },
    });
    expect(prepared.preview.warnings).toEqual([UNKNOWN_REGIME_WARNING]);
  });

  it("accepts tax rule 11 with both warnings, as before", async () => {
    const { plan: prepared } = await plan(
      invoiceCreateDraftTool,
      { ...invoiceCreateArgs, taxRuleId: 11, positions: zeroRated },
      withRoutes(invoiceCreateRoutes, unknownRegimeRoute),
    );
    expect(prepared.state.body["invoice"]).toMatchObject({ smallSettlement: true });
    expect(prepared.preview.warnings).toEqual([
      UNKNOWN_REGIME_WARNING,
      "Tax rule 11 is for small businesses (Kleinunternehmer, §19 UStG) only: the document " +
        "shows no VAT.",
    ]);
  });

  it("warns on updates that change positions or the tax setting only", async () => {
    const routes = withRoutes(invoiceUpdateRoutes, unknownRegimeRoute);
    const header = await plan(invoiceUpdateDraftTool, { id: 2102, header: "Neu" }, routes);
    expect(header.plan.preview.warnings).toEqual([]);
    const positions = await plan(
      invoiceUpdateDraftTool,
      { id: 2102, positions: [{ name: "A", quantity: 1, unitPrice: 1, taxRate: 19 }] },
      routes,
    );
    expect(positions.plan.preview.warnings).toContain(UNKNOWN_REGIME_WARNING);
  });

  it("falls back on a 403 (a restricted user may be refused the account settings)", async () => {
    const forbidden: FakeRoute = {
      path: "/SevClient",
      response: {
        error: new SevdeskError({ kind: "auth", message: "Forbidden.", status: 403 }),
      },
    };
    const { plan: prepared } = await plan(
      invoiceCreateDraftTool,
      invoiceCreateArgs,
      withRoutes(invoiceCreateRoutes, forbidden),
    );
    expect(prepared.preview.warnings).toEqual([UNKNOWN_REGIME_WARNING]);
  });

  it("does not hide a failure that would break any other read", async () => {
    const auth: FakeRoute = {
      path: "/SevClient",
      response: { error: new SevdeskError({ kind: "auth", message: "Token rejected." }) },
    };
    const error = await refusal(
      invoiceCreateDraftTool,
      invoiceCreateArgs,
      withRoutes(invoiceCreateRoutes, auth),
    );
    expect(error.kind).toBe("auth");
  });
});
