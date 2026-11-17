/**
 * The invoice draft previews add a hint, never a refusal, when the tax rule is not one a sale to
 * the customer usually takes (`src/domain/vat/sales-tax-rule.ts`); every other preview text stays
 * as it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invoiceCreateDraftTool } from "../../../../src/tools/invoices/draft-create.js";
import { invoiceUpdateDraftTool } from "../../../../src/tools/invoices/draft-update.js";
import type { AnyWriteToolDefinition } from "../../../../src/tools/types.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { prepareWrite } from "../../../helpers/write-tools.js";
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
