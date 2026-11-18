/**
 * The invoice draft and recurring template previews add a hint, never a refusal, when the tax rule
 * is not one a sale to the customer usually takes (`src/domain/vat/sales-tax-rule.ts`); every
 * other preview text stays as it was. The recurring templates show it in English and German, in
 * the same place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invoiceCreateDraftTool } from "../../../../src/tools/invoices/draft-create.js";
import { invoiceUpdateDraftTool } from "../../../../src/tools/invoices/draft-update.js";
import { invoiceCreateRecurringTool } from "../../../../src/tools/invoices/recurring-create.js";
import { invoiceUpdateRecurringTool } from "../../../../src/tools/invoices/recurring-update.js";
import type { AnyWriteToolDefinition } from "../../../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { prepareWrite } from "../../../helpers/write-tools.js";
import { templateChangeRoutes, templateRow } from "../invoices/recurring-manage-routes.js";
import { recurringCreateArgs, recurringCreateRoutes } from "../invoices/recurring-routes.js";
import {
  invoiceCreateArgs,
  invoiceCreateRoutes,
  invoiceUpdateRoutes,
  unknownRegimeRoute,
  withRoutes,
} from "./routes.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T12:00:00+01:00") });
});

afterEach(() => {
  vi.useRealTimers();
});

type Raw = Record<string, unknown>;

/** Contact 1001 in Austria: by default a company with an Austrian VAT ID, or with `overrides`. */
function austrianContact(overrides: Raw = { vatNumber: "ATU12345678" }): FakeRoute[] {
  const contact = loadFixture("contacts/contact-1001.json").body as { objects: Raw[] };
  const addresses = loadFixture("contacts/contact-addresses-1001.json").body as { objects: Raw[] };
  return [
    {
      path: "/Contact/1001",
      response: { body: { objects: [{ ...contact.objects[0], ...overrides }] } },
    },
    {
      path: "/ContactAddress",
      query: { "contact[id]": 1001 },
      response: {
        body: {
          objects: addresses.objects.map((row) => ({
            ...row,
            country: { id: "14", objectName: "StaticCountry" },
          })),
        },
      },
    },
  ];
}

/** Germany, Austria and Afghanistan, as `GET /StaticCountry` lists them. */
const countries: FakeRoute = {
  path: "/StaticCountry",
  response: {
    body: {
      objects: [
        { id: "1", objectName: "StaticCountry", code: "de", name: "Deutschland" },
        { id: "4", objectName: "StaticCountry", code: "af", name: "Afghanistan" },
        { id: "14", objectName: "StaticCountry", code: "at", name: "Österreich" },
      ],
    },
  },
};

/** Stored positions of draft 2102 at 0 %, so rules that allow only 0 % can be set. */
const zeroRatedStored: FakeRoute = {
  path: "/InvoicePos",
  query: { "invoice[id]": 2102 },
  response: {
    body: {
      objects: [
        {
          id: "5201",
          objectName: "InvoicePos",
          invoice: { id: "2102", objectName: "Invoice" },
          quantity: "1",
          price: "10",
          taxRate: "0",
          positionNumber: "0",
        },
      ],
    },
  },
};

const zeroRated = [{ name: "Beratung", quantity: 2, unitPrice: "50.00", taxRate: 0 }];

async function warnings(
  tool: AnyWriteToolDefinition,
  args: unknown,
  routes: readonly FakeRoute[],
): Promise<readonly string[]> {
  const client = new FakeSevdeskClient(routes);
  const plan = await prepareWrite(tool, args, client);
  expect(client.writes()).toEqual([]);
  return plan.preview.warnings;
}

const HINT = /is not the usual rule for this customer/;

describe("invoice draft: tax rule hint", () => {
  it("stays quiet when the rule fits (the recorded domestic draft)", async () => {
    expect(await warnings(invoiceCreateDraftTool, invoiceCreateArgs, invoiceCreateRoutes)).toEqual(
      [],
    );
  });

  it("hints when a company in another EU state with a VAT ID gets rule 1", async () => {
    const found = await warnings(
      invoiceCreateDraftTool,
      invoiceCreateArgs,
      withRoutes(invoiceCreateRoutes, ...austrianContact(), countries),
    );
    expect(found).toEqual([
      "Tax rule 1 (Umsatzsteuerpflichtige Umsätze) is not the usual rule for this customer (a " +
        "business in Austria with a VAT ID): 3 for goods, 21 for services and digital services. " +
        "It can still be right in a special case; sevdesk_tax_rule_suggest explains the choice. " +
        "A hint, not tax advice.",
    ]);
  });

  it("accepts the reverse-charge rule there, and hints when a domestic customer gets it", async () => {
    const abroad = await warnings(
      invoiceCreateDraftTool,
      { contactId: 1001, taxRuleId: 21, positions: zeroRated },
      withRoutes(invoiceCreateRoutes, ...austrianContact(), countries),
    );
    expect(abroad.filter((warning) => HINT.test(warning))).toEqual([]);
    const domestic = await warnings(
      invoiceCreateDraftTool,
      { contactId: 1001, taxRuleId: 21, positions: zeroRated },
      invoiceCreateRoutes,
    );
    expect(domestic.at(-1)).toContain(
      "(a business in Germany with a VAT ID): 1 for goods, services and digital services.",
    );
  });

  it("takes a person whose VAT ID field holds no VAT ID for a consumer", async () => {
    const person = { name: null, surename: "Max", familyname: "Muster", vatNumber: "n/a" };
    const found = await warnings(
      invoiceCreateDraftTool,
      { contactId: 1001, taxRuleId: 21, positions: zeroRated },
      withRoutes(invoiceCreateRoutes, ...austrianContact(person), countries),
    );
    expect(found.at(-1)).toContain(
      "(a consumer in Austria): 18 or 1 for goods, 1 for services, 19 or 1 for digital services.",
    );
  });

  it("follows an address given in the call", async () => {
    const found = await warnings(
      invoiceCreateDraftTool,
      { ...invoiceCreateArgs, addressCountry: "AF" },
      withRoutes(invoiceCreateRoutes, countries),
    );
    expect(found.at(-1)).toContain(
      "(a business in AF with a VAT ID): 2 for goods, 17 for services and digital services.",
    );
  });

  it("does not hint at rule 11 while the regime is unknown", async () => {
    const found = await warnings(
      invoiceCreateDraftTool,
      { ...invoiceCreateArgs, taxRuleId: 11, positions: zeroRated },
      withRoutes(invoiceCreateRoutes, unknownRegimeRoute),
    );
    expect(found.filter((warning) => HINT.test(warning))).toEqual([]);
  });

  it("judges an update only when it changes the rule, the contact or the address", async () => {
    const routes = withRoutes(invoiceUpdateRoutes, zeroRatedStored);
    expect(await warnings(invoiceUpdateDraftTool, { id: 2102, header: "Neu" }, routes)).toEqual([]);
    const changed = await warnings(invoiceUpdateDraftTool, { id: 2102, taxRuleId: 21 }, routes);
    expect(changed.at(-1)).toMatch(HINT);
    const fitting = await warnings(invoiceUpdateDraftTool, { id: 2102, taxRuleId: 4 }, routes);
    expect(fitting.filter((warning) => HINT.test(warning))).toEqual([]);
    const moved = await warnings(
      invoiceUpdateDraftTool,
      {
        id: 2102,
        addressCountry: "AT",
        addressName: "A",
        addressStreet: "B",
        addressZip: "1",
        addressCity: "C",
      },
      withRoutes(routes, countries, ...austrianContact()),
    );
    expect(moved.at(-1)).toContain("(a business in Austria with a VAT ID)");
  });
});

/** Both previews of a confirmed tool; nothing is written. */
async function bothWarnings(
  tool: AnyWriteToolDefinition,
  args: unknown,
  routes: readonly FakeRoute[],
): Promise<{ readonly en: readonly string[]; readonly de: readonly string[] }> {
  const client = new FakeSevdeskClient(routes);
  const plan = await prepareWrite(tool, args, client);
  expect(client.writes()).toEqual([]);
  if (plan.previewDe === undefined) throw new Error("no German preview");
  expect(plan.previewDe.warnings).toHaveLength(plan.preview.warnings.length);
  return { en: plan.preview.warnings, de: plan.previewDe.warnings };
}

const HINT_DE = /ist für diesen Kunden \(.*\) nicht üblich/;

describe("recurring invoice template: tax rule hint", () => {
  it("stays quiet on a new template when the rule fits", async () => {
    const found = await bothWarnings(
      invoiceCreateRecurringTool,
      recurringCreateArgs,
      recurringCreateRoutes,
    );
    expect(found.en.filter((warning) => HINT.test(warning))).toEqual([]);
    expect(found.de.filter((warning) => HINT_DE.test(warning))).toEqual([]);
  });

  it("hints on a new template for a company in another EU state, in both languages", async () => {
    const found = await bothWarnings(
      invoiceCreateRecurringTool,
      recurringCreateArgs,
      withRoutes(recurringCreateRoutes, ...austrianContact(), countries),
    );
    expect(found.en.at(-1)).toBe(
      "Tax rule 1 (Umsatzsteuerpflichtige Umsätze) is not the usual rule for this customer (a " +
        "business in Austria with a VAT ID): 3 for goods, 21 for services and digital services. " +
        "It can still be right in a special case; sevdesk_tax_rule_suggest explains the choice. " +
        "A hint, not tax advice.",
    );
    expect(found.de.at(-1)).toBe(
      "Steuerregel 1 (Umsatzsteuerpflichtige Umsätze) ist für diesen Kunden (Unternehmen in " +
        "Österreich mit USt-IdNr.) nicht üblich. Üblich ist 3 für Lieferungen, 21 für sonstige " +
        "Leistungen und digitale Leistungen. Im Einzelfall kann sie trotzdem richtig sein; " +
        "sevdesk_tax_rule_suggest erklärt die Wahl. Ein Hinweis, keine Steuerberatung.",
    );
  });

  it("hints on a change of the rule, in both languages", async () => {
    const found = await bothWarnings(
      invoiceUpdateRecurringTool,
      { id: 2301, taxRuleId: 21, positions: zeroRated },
      templateChangeRoutes(),
    );
    expect(found.en.at(-1)).toContain(
      "Tax rule 21 (Reverse Charge gem. §13b Abs. 1 USTG EU Umsätze) is not the usual rule for " +
        "this customer (a business in Germany with a VAT ID): 1 for goods, services and digital " +
        "services.",
    );
    expect(found.de.at(-1)).toContain(
      "Steuerregel 21 (Reverse Charge gem. §13b Abs. 1 USTG EU Umsätze) ist für diesen Kunden " +
        "(Unternehmen in Deutschland mit USt-IdNr.) nicht üblich. Üblich ist 1 für Lieferungen, " +
        "sonstige Leistungen und digitale Leistungen.",
    );
  });

  it("does not judge a change of the text only, even where the rule would not fit", async () => {
    // Template 2301 for the Austrian company, at its address in Austria, with rule 1.
    const austrian = withRoutes(
      templateChangeRoutes(
        templateRow({ addressCountry: { id: "14", objectName: "StaticCountry" } }),
      ),
      ...austrianContact(),
      countries,
    );
    const textOnly = await bothWarnings(
      invoiceUpdateRecurringTool,
      { id: 2301, header: "Wartung" },
      austrian,
    );
    expect(textOnly.en.filter((warning) => HINT.test(warning))).toEqual([]);
    expect(textOnly.de.filter((warning) => HINT_DE.test(warning))).toEqual([]);
    // The same template is judged once the call sets the rule.
    const withRule = await bothWarnings(
      invoiceUpdateRecurringTool,
      { id: 2301, header: "Wartung", taxRuleId: 1 },
      austrian,
    );
    expect(withRule.en.at(-1)).toContain("(a business in Austria with a VAT ID)");
    expect(withRule.de.at(-1)).toContain("(Unternehmen in Österreich mit USt-IdNr.)");
  });
});
