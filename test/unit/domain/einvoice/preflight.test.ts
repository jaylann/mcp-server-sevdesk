import { describe, expect, it } from "vitest";

import { isValidLeitwegId, preflightInvoice } from "../../../../src/domain/einvoice/preflight.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";
import { type FakeRoute, FakeSevdeskClient, loadFixture } from "../../../helpers/fake-client.js";
import { einvoiceText } from "./helpers.js";

type Row = Record<string, unknown>;

function rows(fixture: string): Row[] {
  return structuredClone((loadFixture(fixture).body as { objects: Row[] }).objects);
}

/** Invoice 1001 (community shape) as a complete e-invoice draft, with `change` applied. */
function invoiceBody(change: (invoice: Row) => void = () => undefined): unknown {
  const invoice = rows("invoices/invoice-1001.json")[0]!;
  Object.assign(invoice, {
    status: "100",
    invoiceNumber: null,
    addressName: "Musterfirma GmbH",
    addressStreet: "Musterstraße 1",
    addressZip: "10115",
    addressCity: "Berlin",
  });
  (invoice["contact"] as Row)["buyerReference"] = "04011000-12345-03";
  change(invoice);
  return { objects: [invoice] };
}

const COMPANY: Row = {
  smallSettlement: "0",
  name: "Musterlieferant GmbH",
  addressStreet: "Musterweg 5",
  addressZip: "10115",
  addressCity: "Berlin",
  addressCountry: { id: "1", objectName: "StaticCountry" },
  vatNumber: "DE000000001",
  taxNumber: "00/000/00001",
  bankIban: "DE89370400440532013000",
  bankBic: "COBADEFFXXX",
  contactEmail: "rechnung@example.com",
  contactPhone: "+49 30 0000000",
};

const contactFilter = { "contact[id]": 1001, "contact[objectName]": "Contact" };

interface Setup {
  readonly invoice?: unknown;
  readonly company?: Row | null;
  readonly contact?: FakeRoute["response"];
  readonly positions?: (positions: Row[]) => void;
  readonly units?: FakeRoute["response"];
  readonly xml?: FakeRoute["response"];
}

function routes(setup: Setup = {}): FakeRoute[] {
  const positions = rows("invoices/invoice-positions-1001.json");
  for (const position of positions) position["unity"] = { id: "1", objectName: "Unity" };
  setup.positions?.(positions);
  const contact = rows("contacts/contact-1001.json")[0]!;
  contact["buyerReference"] = "04011000-12345-03";
  return [
    {
      path: "/Invoice/1001",
      query: { embed: "contact" },
      response: { body: setup.invoice ?? invoiceBody() },
    },
    { path: "/InvoicePos", response: { body: { objects: positions } } },
    { path: "/Unity", response: setup.units ?? { fixture: "meta/units.json" } },
    {
      path: "/SevClient",
      response:
        setup.company === null
          ? { error: new SevdeskError({ kind: "not_found", message: "gone" }) }
          : { body: { objects: [setup.company ?? COMPANY] } },
    },
    { path: "/Contact/1001", response: setup.contact ?? { body: { objects: [contact] } } },
    {
      path: "/ContactAddress",
      query: contactFilter,
      response: { fixture: "contacts/contact-addresses-1001.json" },
    },
    {
      path: "/CommunicationWay",
      query: contactFilter,
      response: { fixture: "contacts/communication-ways-1001.json" },
    },
    {
      path: "/Invoice/1001/getXml",
      response: setup.xml ?? {
        body: { objects: einvoiceText("kosit/01.01a-INVOICE_uncefact.xml") },
      },
    },
  ];
}

async function run(setup: Setup = {}) {
  const client = new FakeSevdeskClient(routes(setup));
  const result = await preflightInvoice(client, 1001, { cacheOwner: {}, today: "2026-11-08" });
  const codes = (list: readonly { code: string }[]) => list.map((issue) => issue.code);
  return { client, result, problems: codes(result.problems), warnings: codes(result.warnings) };
}

describe("preflightInvoice", () => {
  it("passes a complete draft and reads only", async () => {
    const { client, result } = await run();
    expect(result).toEqual({
      invoice: {
        id: 1001,
        status: { code: 100, label: "Draft" },
        type: "RE",
        contactId: 1001,
      },
      ready: true,
      problems: [],
      warnings: [],
      xml: { status: "not_finalized" },
    });
    expect(client.writes()).toEqual([]);
    expect(client.callsTo("/Invoice/1001/getXml")).toEqual([]);
    expect(client.callsTo("/SevClient")).toHaveLength(1);
  });

  it("lists every missing piece with the field and the fixing tool", async () => {
    const { result, problems, warnings } = await run({
      company: { smallSettlement: "0", vatNumber: "DE000000001" },
      invoice: invoiceBody((invoice) => {
        Object.assign(invoice, {
          addressName: null,
          addressStreet: null,
          addressCountry: null,
          paymentMethod: null,
          deliveryDate: null,
          timeToPay: null,
          currency: "USD",
          propertyIsEInvoice: "0",
        });
        const contact = invoice["contact"] as Row;
        contact["name"] = null;
        contact["buyerReference"] = null;
      }),
      contact: {
        body: {
          objects: [{ ...rows("contacts/contact-1001.json")[0]!, buyerReference: null }],
        },
      },
      positions: (positions) => {
        positions[0]!["unity"] = { id: "99", objectName: "Unity" };
        delete positions[1]!["unity"];
      },
    });
    expect(problems).toEqual([
      "BR-06",
      "BR-DE-3",
      "BR-09",
      "BR-DE-23-a",
      "PF-SELLER-BIC",
      "BR-DE-7",
      "BR-DE-6",
      "BR-07",
      "BR-DE-8",
      "BR-11",
      "BR-DE-15",
      "PF-NOT-EINVOICE",
      "PF-PAYMENT-METHOD",
      "PF-DELIVERY-DATE",
      "PF-UNIT-CODE",
    ]);
    expect(warnings).toEqual(["PF-SELLER-TAX-NUMBER", "BR-CO-25", "PF-CURRENCY"]);
    expect(result.ready).toBe(false);
    expect(result.invoice.eInvoice).toBe(false);
    expect(result.problems.find((issue) => issue.code === "BR-DE-15")).toMatchObject({
      field: "contact.buyerReference",
      fixWith: "sevdesk_contact_update (buyerReference)",
    });
    expect(result.problems.find((issue) => issue.code === "PF-UNIT-CODE")?.message).toMatch(
      /^2 position\(s\)/,
    );
  });

  it("needs a VAT id or tax number and an e-mail on the contact", async () => {
    const noEmail = {
      body: {
        objects: rows("contacts/communication-ways-1001.json").filter(
          (way) => way["type"] !== "EMAIL",
        ),
      },
    };
    const client = new FakeSevdeskClient(
      routes({ company: { ...COMPANY, vatNumber: null, taxNumber: null } }).map((route) =>
        route.path === "/CommunicationWay" ? { ...route, response: noEmail } : route,
      ),
    );
    const result = await preflightInvoice(client, 1001, { cacheOwner: {} });
    expect(result.problems.map((issue) => issue.code)).toEqual(["BR-CO-26", "PF-BUYER-EMAIL"]);
  });

  it("checks the Leitweg-ID of public authorities", async () => {
    const authority = (reference: string): FakeRoute["response"] => ({
      body: {
        objects: [
          {
            ...rows("contacts/contact-1001.json")[0]!,
            governmentAgency: "1",
            buyerReference: reference,
          },
        ],
      },
    });
    expect((await run({ contact: authority("04011000-12345-03") })).problems).toEqual([]);
    const { result } = await run({ contact: authority("04011000-12345-99") });
    expect(result.problems).toEqual([
      expect.objectContaining({ code: "PF-LEITWEG-ID", field: "contact.buyerReference" }),
    ]);
  });

  it("refuses One-Stop-Shop rules and needs the buyer's VAT id for rules 3, 5 and 21", async () => {
    const withRule = (id: string) =>
      invoiceBody((invoice) => void (invoice["taxRule"] = { id, objectName: "TaxRule" }));
    expect((await run({ invoice: withRule("18") })).problems).toEqual(["PF-TAX-RULE-OSS"]);
    const noVat = {
      body: {
        objects: [
          { ...rows("contacts/contact-1001.json")[0]!, vatNumber: null, buyerReference: "x" },
        ],
      },
    };
    expect((await run({ invoice: withRule("3"), contact: noVat })).problems).toEqual(["BR-K-02"]);
    expect((await run({ invoice: withRule("5"), contact: noVat })).problems).toEqual(["BR-AE-02"]);
    expect(
      (await run({ invoice: invoiceBody((invoice) => void (invoice["taxRule"] = null)) })).warnings,
    ).toEqual(["PF-TAX-RULE"]);
  });

  it("wants the §19 UStG note on Kleinunternehmer invoices", async () => {
    const small = (footText: string | null) =>
      invoiceBody((invoice) => {
        invoice["taxRule"] = { id: "11", objectName: "TaxRule" };
        invoice["footText"] = footText;
      });
    expect((await run({ invoice: small(null) })).warnings).toEqual(["BR-E-10"]);
    expect(
      (await run({ invoice: small("Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.") }))
        .warnings,
    ).toEqual([]);
  });

  it("keeps going when units, the contact or the account settings cannot be read", async () => {
    const { warnings, problems } = await run({
      units: { error: new SevdeskError({ kind: "server", message: "down" }) },
      contact: { error: new SevdeskError({ kind: "not_found", message: "gone" }) },
      company: null,
    });
    expect(warnings).toEqual(["PF-SELLER-UNKNOWN", "PF-BUYER-UNREADABLE", "PF-UNITS-UNKNOWN"]);
    expect(problems).toEqual([]);
  });

  it("rethrows a cancellation while reading units", async () => {
    const client = new FakeSevdeskClient(
      routes({ units: { error: new SevdeskError({ kind: "aborted", message: "cancelled" }) } }),
    );
    await expect(preflightInvoice(client, 1001, { cacheOwner: {} })).rejects.toMatchObject({
      kind: "aborted",
    });
  });

  it("reports a missing draft invoice and positions", async () => {
    const empty = await run({ positions: (positions) => void positions.splice(0) });
    expect(empty.problems).toEqual(["BR-16"]);
    const noContact = await run({
      invoice: invoiceBody((invoice) => void (invoice["contact"] = null)),
    });
    expect(noContact.problems).toEqual(["PF-BUYER-CONTACT"]);
  });

  describe("finalized invoices", () => {
    const finalized = invoiceBody((invoice) => {
      invoice["status"] = "200";
      invoice["invoiceNumber"] = "RE-1001";
    });

    it("parses sevDesk's XML and adds its findings", async () => {
      const { result, client } = await run({ invoice: finalized });
      expect(result.xml).toEqual({
        status: "checked",
        syntax: "cii",
        profile: "xrechnung",
        errors: 0,
        warnings: 0,
      });
      expect(result.ready).toBe(true);
      expect(result.invoice.number).toBe("RE-1001");
      expect(client.writes()).toEqual([]);

      const broken = einvoiceText("kosit/01.01a-INVOICE_uncefact.xml").replace(
        "<ram:LineTotalAmount>314.86</ram:LineTotalAmount>",
        "<ram:LineTotalAmount>314.87</ram:LineTotalAmount>",
      );
      const withErrors = await run({ invoice: finalized, xml: { body: { objects: broken } } });
      expect(withErrors.problems).toContain("BR-CO-10");
      expect(withErrors.result.problems[0]?.message).toMatch(/^XML: /);
    });

    it("checks the XRechnung sevDesk itself generated without findings (recorded)", async () => {
      // getXml of a finalized trial invoice (probe write-einvoice-xml, 2026-11-08), scrubbed.
      const recorded = einvoiceText("sevdesk/xrechnung-3.0-cii.xml");
      const { result } = await run({ invoice: finalized, xml: { body: { objects: recorded } } });
      expect(result.xml).toEqual({
        status: "checked",
        syntax: "cii",
        profile: "xrechnung",
        errors: 0,
        warnings: 0,
      });
      expect(result.ready).toBe(true);
    });

    it("reports a finalized invoice without XML", async () => {
      const refused = {
        error: new SevdeskError({ kind: "validation", status: 400, message: "not an e-invoice" }),
      };
      const { result } = await run({ invoice: finalized, xml: refused });
      expect(result.xml).toEqual({ status: "not_available" });
      expect(result.problems.map((issue) => issue.code)).toEqual(["PF-NO-XML"]);
    });

    it("reports XML that cannot be read and passes other errors on", async () => {
      const unreadable = await run({
        invoice: finalized,
        xml: { body: { objects: "<Order xmlns='urn:x'/>" } },
      });
      expect(unreadable.problems).toEqual(["PF-XML-UNREADABLE"]);
      const client = new FakeSevdeskClient(
        routes({
          invoice: finalized,
          xml: { error: new SevdeskError({ kind: "server", message: "down" }) },
        }),
      );
      await expect(preflightInvoice(client, 1001, { cacheOwner: {} })).rejects.toMatchObject({
        kind: "server",
      });
    });
  });
});

describe("isValidLeitwegId", () => {
  it.each([
    ["04011000-12345-03", true],
    ["04011000-12349-88", true],
    ["04011000-1234512345-06", true],
    ["991-33333TEST-33", true],
    ["991-33333test-33", true],
    ["04011000-12345-04", false],
    ["0401100012345", false],
    ["4-12345-03", false],
  ])("%s → %s", (value, valid) => {
    expect(isValidLeitwegId(value)).toBe(valid);
  });
});
