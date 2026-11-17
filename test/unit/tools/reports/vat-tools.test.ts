import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../../../src/config.js";
import type { TaxRuleSuggestion } from "../../../../src/domain/vat/tax-rule-helper.js";
import type { VatIdCheck } from "../../../../src/domain/vat/vat-id-check.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { swapViesFetch } from "../../../../src/sevdesk/vies-request.js";
import {
  REPORT_VAT_TOOLS,
  taxRuleSuggestTool,
  vatIdCheckTool,
} from "../../../../src/tools/reports/vat-tools.js";
import {
  type FakeRoute,
  FakeSevdeskClient,
  loadFixture,
  testContext,
} from "../../../helpers/fake-client.js";
import { createFakeFetch, type FakeFetch, jsonResponse } from "../../../helpers/fake-fetch.js";

type Raw = Record<string, unknown>;

const TOKEN_ENV = {};
const VIES_ON = { SEVDESK_VIES_CHECK: "1" };

/** The recorded-shape contact 1001 with overrides (fake values). */
function contactRow(id: string, overrides: Raw): Raw {
  const body = loadFixture("contacts/contact-1001.json").body as { objects: Raw[] };
  return { ...structuredClone(body.objects[0]), id, ...overrides };
}

/** A contact with one invoice address in StaticCountry `countryId` (or none). */
function contactRoutes(id: number, overrides: Raw, countryId?: number): FakeRoute[] {
  const address = {
    id: String(id + 5000),
    objectName: "ContactAddress",
    contact: { id: String(id), objectName: "Contact" },
    street: "Musterstraße 1",
    zip: "1010",
    city: "Musterstadt",
    country:
      countryId === undefined ? null : { id: String(countryId), objectName: "StaticCountry" },
    category: { id: "47", objectName: "Category" },
    name: "Rechnungsanschrift",
  };
  return [
    {
      path: `/Contact/${String(id)}`,
      response: { body: { objects: [contactRow(String(id), overrides)] } },
    },
    {
      path: "/ContactAddress",
      query: { "contact[id]": id },
      response: { body: { objects: [address] } },
    },
    {
      path: "/CommunicationWay",
      query: { "contact[id]": id },
      response: { body: { objects: [] } },
    },
  ];
}

const countriesRoute: FakeRoute = {
  path: "/StaticCountry",
  response: {
    body: {
      objects: [
        { id: "1", objectName: "StaticCountry", code: "de", name: "Deutschland" },
        { id: "14", objectName: "StaticCountry", code: "at", name: "Österreich" },
        { id: "15", objectName: "StaticCountry", code: "fr", name: "Frankreich" },
        { id: "16", objectName: "StaticCountry", code: "ch", name: "Schweiz" },
      ],
    },
  },
};

const regularAccount: FakeRoute = {
  path: "/SevClient",
  response: { fixture: "drafts/sev-client.json" },
};
const smallBusinessAccount: FakeRoute = {
  path: "/SevClient",
  response: { fixture: "drafts/sev-client-small-business.json" },
};
const unreadableAccount: FakeRoute = {
  path: "/SevClient",
  response: { error: new SevdeskError({ kind: "not_found", message: "sevDesk found nothing." }) },
};

const routes: FakeRoute[] = [
  regularAccount,
  countriesRoute,
  // Musterfirma GmbH, Germany, VAT ID DE000000000.
  { path: "/Contact/1001", response: { fixture: "contacts/contact-1001.json" } },
  {
    path: "/ContactAddress",
    query: { "contact[id]": 1001 },
    response: { fixture: "contacts/contact-addresses-1001.json" },
  },
  {
    path: "/CommunicationWay",
    query: { "contact[id]": 1001 },
    response: { fixture: "contacts/communication-ways-1001.json" },
  },
  // An Austrian company with a VAT ID, a French private customer, a contact without address.
  ...contactRoutes(2001, { name: "Wiener Muster GmbH", vatNumber: "ATU12345678" }, 14),
  ...contactRoutes(
    2002,
    { name: null, surename: "Marie", familyname: "Muster", vatNumber: null },
    15,
  ),
  ...contactRoutes(2003, { name: "Ohne Land AG", vatNumber: null }),
  {
    path: "/Contact/4040",
    response: { error: new SevdeskError({ kind: "not_found", message: "sevDesk found nothing." }) },
  },
];

let vies: FakeFetch | undefined;
let restore: (() => void) | undefined;

/** Records every VIES request; answers with `replies` in order. */
function watchVies(...replies: Parameters<typeof createFakeFetch>): FakeFetch {
  vies = createFakeFetch(...replies);
  restore = swapViesFetch(vies.fetch);
  return vies;
}

afterEach(() => {
  restore?.();
  restore = undefined;
  vies = undefined;
});

async function suggest(
  args: Record<string, unknown>,
  extra: FakeRoute[] = [],
  env: Readonly<Record<string, string>> = TOKEN_ENV,
) {
  const client = new FakeSevdeskClient([...extra, ...routes]);
  const result = await taxRuleSuggestTool.handler(
    taxRuleSuggestTool.input.parse(args),
    testContext(client, env),
  );
  const data: TaxRuleSuggestion = taxRuleSuggestTool.output.parse(result.data);
  return { client, data, summary: result.summary };
}

async function rejection(args: Record<string, unknown>): Promise<SevdeskError> {
  try {
    await suggest(args);
  } catch (error) {
    if (error instanceof SevdeskError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

async function checkId(vatId: string, env: Readonly<Record<string, string>> = TOKEN_ENV) {
  const client = new FakeSevdeskClient([]);
  const result = await vatIdCheckTool.handler(
    vatIdCheckTool.input.parse({ vatId }),
    testContext(client, env),
  );
  const data: VatIdCheck = vatIdCheckTool.output.parse(result.data);
  return { client, data, summary: result.summary };
}

describe("metadata", () => {
  it("are two read tools of the reports toolset; only the VAT-ID check may reach out", () => {
    expect(REPORT_VAT_TOOLS.map((tool) => tool.name)).toEqual([
      "sevdesk_tax_rule_suggest",
      "sevdesk_vat_id_check",
    ]);
    for (const tool of REPORT_VAT_TOOLS) {
      expect(tool).toMatchObject({ tier: "read", toolset: "reports" });
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(tool.localEffects).toBeUndefined();
    }
    expect(taxRuleSuggestTool.annotations.openWorldHint).toBe(false);
    expect(vatIdCheckTool.annotations.openWorldHint).toBe(true);
    expect(taxRuleSuggestTool.description).toContain("Steuerregel");
    expect(taxRuleSuggestTool.description).toContain("not tax advice");
    expect(vatIdCheckTool.description).toContain("USt-IdNr.");
    expect(vatIdCheckTool.description).toContain("SEVDESK_VIES_CHECK");
  });

  it("take flat, strict inputs", () => {
    expect(Object.keys(taxRuleSuggestTool.input.shape)).toEqual([
      "supply",
      "contactId",
      "country",
      "customerType",
      "vatId",
    ]);
    expect(() => taxRuleSuggestTool.input.parse({ supply: "goods", extra: 1 })).toThrow();
    expect(() => taxRuleSuggestTool.input.parse({ supply: "goods", country: "DEU" })).toThrow();
    expect(() => taxRuleSuggestTool.input.parse({ supply: "rent" })).toThrow();
    expect(() => vatIdCheckTool.input.parse({ vatId: "" })).toThrow();
    expect(() => vatIdCheckTool.input.parse({ vatId: "x".repeat(31) })).toThrow();
  });
});

describe("sevdesk_tax_rule_suggest", () => {
  it("takes country, type and VAT ID from the contact and the regime from sevDesk", async () => {
    const { client, data, summary } = await suggest({ contactId: 1001, supply: "services" });
    expect(data.customer).toEqual({
      contactId: 1001,
      country: "DE",
      countryName: "Germany",
      countryFrom: "contact_address",
      area: "germany",
      type: "business",
      typeFrom: "contact_vat_id",
    });
    expect(data.regime).toBe("regular");
    expect(data.decided).toBe(true);
    expect(data.suggestions).toEqual([
      expect.objectContaining({
        taxRuleId: 1,
        taxRuleName: "Umsatzsteuerpflichtige Umsätze",
        taxRuleNameEn: "Taxable domestic revenue",
        rate: "19",
      }),
    ]);
    expect(data.exceptions.map((outcome) => outcome.taxRuleId)).toEqual([4, 5, 17]);
    expect(data.vatId).toMatchObject({ status: "valid_format", country: "DE" });
    expect(data.disclaimer.en).toContain("Not tax advice");
    expect(data.disclaimer.de).toContain("Keine Steuerberatung");
    expect(summary).toBe(
      "Tax rule 1 (Umsatzsteuerpflichtige Umsätze) for services to a business in Germany. " +
        "3 exception(s). Not tax advice.",
    );
    expect(client.writes()).toEqual([]);
  });

  it("suggests an intra-EU supply for an Austrian company with a VAT ID", async () => {
    const { data } = await suggest({ contactId: 2001, supply: "goods" });
    expect(data.customer).toMatchObject({ country: "AT", type: "business", area: "eu" });
    expect(data.suggestions[0]).toMatchObject({
      taxRuleId: 3,
      rate: "0",
      invoiceNote: { de: "Steuerfreie innergemeinschaftliche Lieferung", required: true },
    });
    const services = await suggest({ contactId: 2001, supply: "services" });
    expect(services.data.suggestions[0]).toMatchObject({
      taxRuleId: 21,
      invoiceNote: { de: "Steuerschuldnerschaft des Leistungsempfängers", required: true },
    });
  });

  it("returns both One-Stop-Shop outcomes for a French private customer, with France's rate", async () => {
    const { data, summary } = await suggest({ contactId: 2002, supply: "digital_services" });
    expect(data.customer).toMatchObject({
      country: "FR",
      type: "consumer",
      typeFrom: "contact_person",
    });
    expect(data.decided).toBe(false);
    expect(data.suggestions.map((outcome) => [outcome.taxRuleId, outcome.rate])).toEqual([
      [19, "20"],
      [1, "19"],
    ]);
    expect(summary).toContain("depending on facts not known here");
  });

  it("works from the call's facts alone, reading only the account settings", async () => {
    const { client, data } = await suggest({
      supply: "services",
      country: "ch",
      customerType: "consumer",
    });
    expect(client.calls.map((call) => call.path)).toEqual(["/SevClient"]);
    expect(data.customer).toEqual({
      country: "CH",
      countryFrom: "input",
      area: "non_eu",
      type: "consumer",
      typeFrom: "input",
    });
    expect(data.suggestions.map((outcome) => outcome.taxRuleId)).toEqual([17, 1]);
    expect(data).not.toHaveProperty("vatId");
  });

  it("takes a VAT ID as a business customer, reads EL as Greece and lets the call win", async () => {
    const byVat = await suggest({ supply: "goods", country: "EL", vatId: "EL 123 456 789" });
    expect(byVat.data.customer).toMatchObject({
      country: "GR",
      type: "business",
      typeFrom: "vat_id",
    });
    expect(byVat.data.suggestions[0]?.taxRuleId).toBe(3);
    const overridden = await suggest({
      contactId: 1001,
      supply: "goods",
      country: "AT",
      vatId: "ATU12345678",
    });
    expect(overridden.data.customer).toMatchObject({ country: "AT", countryFrom: "input" });
    expect(overridden.data.suggestions[0]?.taxRuleId).toBe(3);
  });

  it("treats Northern Ireland as the EU for goods and outside it for services", async () => {
    // The review's case: an XI VAT ID with GB (sevDesk's country for Northern Ireland) or XI.
    for (const country of ["GB", "XI"]) {
      const goods = await suggest({
        supply: "goods",
        country,
        customerType: "business",
        vatId: "XI123456789",
      });
      expect(goods.data.customer, country).toMatchObject({ country, area: "eu" });
      expect(
        goods.data.suggestions.map((outcome) => outcome.taxRuleId),
        country,
      ).toEqual([3]);
      expect(goods.data.vatId, country).toMatchObject({ status: "valid_format", country: "XI" });
      expect(goods.data.warnings, country).toEqual([]);
    }
    const services = await suggest({ supply: "services", country: "xi", vatId: "XI123456789" });
    expect(services.data.customer).toMatchObject({
      country: "XI",
      countryName: "Northern Ireland",
      area: "non_eu",
      type: "business",
    });
    expect(services.data.suggestions.map((outcome) => outcome.taxRuleId)).toEqual([17]);
  });

  it("uses rule 11 on a Kleinunternehmer account and says when the regime is unknown", async () => {
    const small = await suggest({ contactId: 2001, supply: "goods" }, [smallBusinessAccount]);
    expect(small.data.regime).toBe("small_business");
    expect(small.data.suggestions.map((outcome) => outcome.taxRuleId)).toEqual([11]);
    const unknown = await suggest({ contactId: 1001, supply: "goods" }, [unreadableAccount]);
    expect(unknown.data.regime).toBe("unknown");
    expect(unknown.data.warnings[0]).toContain("regular VAT is assumed");
    expect(unknown.data.exceptions.map((outcome) => outcome.taxRuleId)).toContain(11);
  });

  it("refuses with guidance when the customer's place or type is unknown", async () => {
    expect((await rejection({ supply: "goods" })).message).toBe(
      "Say where the customer is: pass country (ISO code such as AT) or contactId.",
    );
    expect((await rejection({ supply: "goods", country: "AT" })).message).toContain(
      "pass customerType",
    );
    expect((await rejection({ supply: "goods", contactId: 2003 })).message).toBe(
      "Contact 2003 has no address with a country sevDesk can name. Pass country (ISO code such " +
        "as AT).",
    );
    const missing = await rejection({ supply: "goods", contactId: 4040 });
    expect(missing.kind).toBe("validation");
    expect(missing.message).toContain("does not exist");
  });

  it("never asks VIES, even when the live check is on", async () => {
    const watched = watchVies(jsonResponse({ valid: true }));
    await suggest({ contactId: 2001, supply: "goods" }, [], VIES_ON);
    await suggest({ supply: "services", country: "AT", vatId: "ATU12345678" }, [], VIES_ON);
    expect(watched.requests).toEqual([]);
  });
});

describe("sevdesk_vat_id_check", () => {
  it("is off by default: checks the format and sends nothing", async () => {
    const watched = watchVies(jsonResponse({ valid: true }));
    expect(loadConfig({ SEVDESK_API_TOKEN: "0123456789abcdef0123456789abcdef" }).viesCheck).toBe(
      false,
    );
    for (const vatId of ["ATU12345678", "ATU1", "CHE123456789", "???"]) {
      const { data, client } = await checkId(vatId);
      expect(data.vies.status, vatId).toBe("off");
      expect(client.calls).toEqual([]);
    }
    expect(watched.requests).toEqual([]);
    const { data, summary } = await checkId("ATU12345678");
    expect(data.format).toMatchObject({ status: "valid_format", country: "AT" });
    expect(data.notes[0]).toContain("not proof");
    expect(summary).toBe(
      "The VAT ID fits the format of Austria. The live VIES check is off on this server " +
        "(setting SEVDESK_VIES_CHECK); only the format was checked and nothing was sent anywhere.",
    );
    expect(summary).not.toContain("12345678");
  });

  it("asks VIES when the operator switched it on, sending only the number", async () => {
    const watched = watchVies(
      jsonResponse({ valid: true, requestDate: "2026-11-16+01:00", name: "---", address: "---" }),
    );
    const { data } = await checkId("EL 123456789", VIES_ON);
    expect(watched.requests).toHaveLength(1);
    expect(JSON.parse(String(watched.requests[0]?.body))).toEqual({
      countryCode: "EL",
      vatNumber: "123456789",
    });
    expect(data.vies).toEqual({
      status: "valid",
      checkedOn: "2026-11-16",
      message:
        "VIES confirms the VAT ID as valid on 2026-11-16. Keep this result with the invoice.",
    });
  });

  it("asks VIES about a number of Northern Ireland (XI)", async () => {
    const watched = watchVies(jsonResponse({ valid: true, requestDate: "2026-11-16+01:00" }));
    const { data, summary } = await checkId("XI 123 456 789", VIES_ON);
    expect(JSON.parse(String(watched.requests[0]?.body))).toEqual({
      countryCode: "XI",
      vatNumber: "123456789",
    });
    expect(data.format).toMatchObject({ status: "valid_format", country: "XI" });
    expect(data.vies.status).toBe("valid");
    expect(summary).toContain("The VAT ID fits the format of Northern Ireland.");
  });

  it("reports an invalid number and an unavailable service", async () => {
    watchVies(
      jsonResponse({ valid: false }),
      jsonResponse({ actionSucceed: false, errorWrappers: [{ error: "MS_UNAVAILABLE" }] }, 500),
    );
    const invalid = await checkId("DE123456789", VIES_ON);
    expect(invalid.data.vies.status).toBe("invalid");
    const down = await checkId("DE123456789", VIES_ON);
    expect(down.data.vies).toMatchObject({
      status: "unavailable",
      reason: "member_state_unavailable",
    });
  });

  it("never sends a number in the wrong format, of another country or unreadable", async () => {
    const watched = watchVies();
    for (const vatId of ["ATU1234", "CHE123456789", "123"]) {
      const { data } = await checkId(vatId, VIES_ON);
      expect(data.vies.status, vatId).toBe("not_sent");
      expect(data.notes).toHaveLength(1);
    }
    expect(watched.requests).toEqual([]);
  });

  it("reads the setting as a flag and refuses a value that is not one", () => {
    const token = { SEVDESK_API_TOKEN: "0123456789abcdef0123456789abcdef" };
    expect(loadConfig({ ...token, SEVDESK_VIES_CHECK: "on" }).viesCheck).toBe(true);
    expect(loadConfig({ ...token, SEVDESK_VIES_CHECK: "0" }).viesCheck).toBe(false);
    expect(() => loadConfig({ ...token, SEVDESK_VIES_CHECK: "maybe" })).toThrow(
      "SEVDESK_VIES_CHECK",
    );
  });
});
