import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { invoiceEInvoicePreflightTool as tool } from "../../../../src/tools/invoices/einvoice-preflight.js";
import { INVOICE_EINVOICE_TOOLS } from "../../../../src/tools/invoices/einvoice-tools.js";
import { type FakeRoute, FakeSevdeskClient, testContext } from "../../../helpers/fake-client.js";

const contactFilter = { "contact[id]": 1001, "contact[objectName]": "Contact" };
const XML = readFileSync(
  new URL("../../../fixtures/einvoice/kosit/01.01a-INVOICE_uncefact.xml", import.meta.url),
  "utf8",
);

/** Invoice 1001 (open, community shape) with its contact, positions and units. */
function routes(xml: FakeRoute["response"]): FakeRoute[] {
  return [
    {
      path: "/Invoice/1001",
      query: { embed: "contact" },
      response: { fixture: "invoices/invoice-1001.json" },
    },
    { path: "/InvoicePos", response: { fixture: "invoices/invoice-positions-1001.json" } },
    { path: "/Unity", response: { fixture: "meta/units.json" } },
    { path: "/SevClient", response: { fixture: "drafts/sev-client.json" } },
    { path: "/Contact/1001", response: { fixture: "contacts/contact-1001.json" } },
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
    { path: "/Invoice/1001/getXml", response: xml },
  ];
}

describe("sevdesk_invoice_einvoice_preflight", () => {
  it("is a read tool of the invoices toolset", () => {
    expect(INVOICE_EINVOICE_TOOLS).toContain(tool);
    expect(tool).toMatchObject({ tier: "read", toolset: "invoices" });
    expect(tool.localEffects).toBeUndefined();
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(() => tool.input.parse({ id: 0 })).toThrow();
  });

  it("checks an open invoice and the XML sevDesk generated, with GETs only", async () => {
    const client = new FakeSevdeskClient(routes({ body: { objects: XML } }));
    const result = await tool.handler(tool.input.parse({ id: 1001 }), testContext(client));
    const data = tool.output.parse(result.data);
    expect(client.writes()).toEqual([]);
    expect(data.invoice).toMatchObject({ id: 1001, number: "RE-1001", type: "RE" });
    expect(data.xml).toMatchObject({ status: "checked", profile: "xrechnung", errors: 0 });
    expect(data.ready).toBe(false);
    // The recorded account has no address, bank data or tax ids; the contact no buyer reference.
    expect(data.problems.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["BR-CO-26", "BR-DE-23-a", "BR-DE-15", "BR-DE-8", "PF-UNIT-CODE"]),
    );
    expect(result.summary).toBe(
      `Invoice 1001 (status Open / due) is not ready for an e-invoice: ${String(data.problems.length)} ` +
        `problem(s), ${String(data.warnings.length)} warning(s). sevDesk's XML was parsed and checked.`,
    );
  });

  it("says when sevDesk has no XML", async () => {
    const client = new FakeSevdeskClient(routes({ body: { objects: null } }));
    const result = await tool.handler(tool.input.parse({ id: 1001 }), testContext(client));
    expect(result.data.xml.status).toBe("not_available");
    expect(result.summary).toContain("sevDesk has no e-invoice XML for it.");
  });
});
