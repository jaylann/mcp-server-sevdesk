import { describe, expect, it } from "vitest";

import {
  assertNoSecrets,
  createScrubber,
  FAKE_PDF_BASE64,
  REDACTED,
} from "../../../scripts/lib/scrub.js";
import { loadFixture } from "../../helpers/fake-client.js";

const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

function scrubber() {
  return createScrubber({ secrets: [TOKEN] });
}

/** Every key path of a JSON value with the JS type of its leaf, to compare shapes. */
function shape(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => shape(item, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, member]) => shape(member, `${path}.${key}`));
  }
  return [`${path}:${value === null ? "null" : typeof value}`];
}

describe("createScrubber", () => {
  it("replaces contact data with obvious fakes and keeps keys, nulls and scalar types", () => {
    const contact = {
      id: "1001",
      objectName: "Contact",
      name: "Hans Huber Bau GmbH",
      name2: "Buchhaltung",
      surename: null,
      familyname: "Huber",
      customerNumber: "K-1038",
      vatNumber: "DE123456789",
      taxNumber: "143/123/45678",
      bankAccount: "DE89 3704 0044 0532 0130 00",
      bankNumber: "COBADEFFXXX",
      description: "Stammkunde seit 2019, Ansprechpartner Herr Huber",
      category: { id: "3", objectName: "Category" },
      sevClient: { id: "512345", objectName: "SevClient" },
      exemptVat: "0",
      defaultTimeToPay: "14",
      defaultDiscountAmount: 0,
      create: "2026-02-19T14:06:30+01:00",
      status: "1000",
      buyerReference: "991-12345-67",
    };

    const scrubbed = scrubber().scrub(contact) as Record<string, unknown>;

    expect(shape(scrubbed)).toEqual(shape(contact));
    expect(scrubbed).toMatchObject({
      id: "1001",
      objectName: "Contact",
      name: "Musterfirma 1 GmbH",
      name2: "Musterfirma 2 GmbH",
      surename: null,
      familyname: "Mustermann1",
      customerNumber: "K-0001",
      vatNumber: "DE000000001",
      taxNumber: "000/000/00001",
      bankAccount: "DE00000000000000000001",
      description: "Muster-Text 1",
      category: { id: "3", objectName: "Category" },
      sevClient: { id: "9001", objectName: "SevClient" },
      exemptVat: "0",
      defaultTimeToPay: "14",
      defaultDiscountAmount: 0,
      create: "2026-02-19T14:06:30+01:00",
      status: "1000",
      buyerReference: "00000000-00001-00",
    });
    expect(scrubbed["bankNumber"]).toMatch(/^TEST\d\d/);
    expect(JSON.stringify(scrubbed)).not.toMatch(/Huber|143\/123|3704|COBADE|512345|991-12345/);
  });

  it("maps the same value to the same fake across objects of one run", () => {
    const s = scrubber();
    const contact = s.scrub({ objectName: "Contact", name: "ACME AG", email: "info@acme.de" });
    const invoice = s.scrub({
      objectName: "Invoice",
      addressName: "ACME AG",
      contact: { objectName: "Contact", name: "ACME AG" },
      header: "Rechnung für info@acme.de",
    });

    expect(contact).toEqual({
      objectName: "Contact",
      name: "Musterfirma 1 GmbH",
      email: "person1@example.com",
    });
    expect(invoice).toMatchObject({
      addressName: "Musterfirma 1 GmbH",
      contact: { name: "Musterfirma 1 GmbH" },
      header: "Muster-Text 1",
    });
  });

  it("scrubs people, logins and IPs of sevDesk users", () => {
    const user = loadFixture("meta/sev-users.json").body as { objects: unknown[] };
    const scrubbed = scrubber().scrub(user) as { objects: Record<string, unknown>[] };
    const first = scrubbed.objects[0]!;

    expect(shape(scrubbed)).toEqual(shape(user));
    expect(first).toMatchObject({
      objectName: "SevUser",
      fullname: "Max Mustermann1",
      firstName: "Vorname1",
      lastName: "Mustermann1",
      username: "person1@example.com",
      email: "person1@example.com",
      memberCode: "MM",
      sevClient: { id: "9001", objectName: "SevClient" },
      role: "admin",
      languageCode: "de_DE",
      status: "100",
    });
    expect(first["lastLoginIp"]).toMatch(/^192\.0\.2\.\d+$/);
  });

  it("keeps system reference data verbatim (object names and reference mode)", () => {
    const taxRules = loadFixture("meta/tax-rules.json").body;
    expect(scrubber().scrub(taxRules)).toEqual(taxRules);

    const version = { objects: { version: "2.0" } };
    expect(scrubber().scrub(version, "reference")).toEqual(version);

    const units = {
      objects: [{ id: "1", objectName: "Unity", name: "Stk", translationCode: "X" }],
    };
    expect(scrubber().scrub(units)).toEqual(units);
  });

  it("still applies the safety patterns to reference data", () => {
    const scrubbed = scrubber().scrub(
      {
        objects: [
          {
            objectName: "Category",
            name: "Kunde",
            sevClient: { id: "512345", objectName: "SevClient" },
            note: "contact info@example.org or https://my.sevdesk.de/x?token=abc",
          },
        ],
      },
      "reference",
    );
    expect(scrubbed).toEqual({
      objects: [
        {
          objectName: "Category",
          name: "Kunde",
          sevClient: { id: "9001", objectName: "SevClient" },
          note: "contact person1@example.com or https://example.com/scrubbed/1",
        },
      ],
    });
  });

  it("replaces the token wherever it occurs, also inside longer strings", () => {
    const s = scrubber();
    const scrubbed = s.scrub({
      objects: {
        status: TOKEN,
        header: `Authorization: ${TOKEN}`,
        nested: [{ code: `x${TOKEN}y` }],
      },
    });
    const json = JSON.stringify(scrubbed);

    expect(json).not.toContain(TOKEN);
    expect(scrubbed).toMatchObject({ objects: { status: REDACTED } });
    expect(s.stats().byRule["secret"]).toBe(3);
    expect(() => {
      assertNoSecrets(json, [TOKEN]);
    }).not.toThrow();
  });

  it("replaces 32-hex tokens (upload file names, hashes) deterministically", () => {
    const s = scrubber();
    const scrubbed = s.scrub({
      objects: {
        filename: "f019bec36c65f5a0e7d2c63cc33f0681.pdf",
        hash: "F019BEC36C65F5A0E7D2C63CC33F0681",
        other: "00112233445566778899aabbccddeeff",
      },
    }) as { objects: Record<string, string> };

    expect(scrubbed.objects["filename"]).toBe("datei-1.pdf");
    expect(scrubbed.objects["hash"]).toBe(`${"0".repeat(31)}1`);
    expect(scrubbed.objects["other"]).toBe(`${"0".repeat(31)}2`);
  });

  it("replaces addresses, phones, IBANs and bank purposes of transactions and addresses", () => {
    const scrubbed = scrubber().scrub({
      objects: [
        {
          objectName: "ContactAddress",
          street: "Hauptstraße 5",
          zip: "80331",
          city: "München",
          country: { id: "1", objectName: "StaticCountry" },
        },
        {
          objectName: "CommunicationWay",
          type: "PHONE",
          value: "+49 89 1234567",
        },
        {
          objectName: "CommunicationWay",
          type: "WEB",
          value: "https://huber-bau.de",
        },
        {
          objectName: "CheckAccountTransaction",
          amount: "-250",
          paymtPurpose: "RE-1038 Huber Bau",
          payeePayerName: "Hans Huber",
          payeePayerAcctNo: "DE89370400440532013000",
          payeePayerBankCode: "COBADEFFXXX",
          entryDate: "2026-02-19T00:00:00+01:00",
        },
        {
          objectName: "Invoice",
          address: "Huber Bau GmbH\nHauptstraße 5\n80331 München",
          addressStreet: "Hauptstraße 5",
          addressZip: "80331",
          addressCity: "München",
          addressGender: "m",
          invoiceNumber: "RE-%YYYY%MM1038",
          currency: "EUR",
          invoiceType: "RE",
          sendType: "VPR",
          sumNet: "100.00",
          taxText: "Umsatzsteuer 19%",
        },
      ],
    }) as { objects: Record<string, unknown>[] };

    const [address, phone, web, transaction, invoice] = scrubbed.objects;
    expect(address).toEqual({
      objectName: "ContactAddress",
      street: "Musterstraße 1",
      zip: "00001",
      city: "Musterstadt 1",
      country: { id: "1", objectName: "StaticCountry" },
    });
    expect(phone?.["value"]).toBe("+49 30 0000001");
    expect(web?.["value"]).toBe("https://example.com/scrubbed/1");
    expect(transaction).toMatchObject({
      amount: "-250",
      paymtPurpose: "Muster-Text 1",
      payeePayerName: "Musterfirma 1 GmbH",
      payeePayerAcctNo: "DE00000000000000000001",
      entryDate: "2026-02-19T00:00:00+01:00",
    });
    expect(invoice).toMatchObject({
      address: "Musterfirma 1 GmbH\nMusterstraße 1\n00000 Musterstadt",
      addressStreet: "Musterstraße 1",
      addressZip: "00001",
      addressCity: "Musterstadt 1",
      addressGender: "m",
      invoiceNumber: "RE-%YYYY%MM0001",
      currency: "EUR",
      invoiceType: "RE",
      sendType: "VPR",
      sumNet: "100.00",
      taxText: "Umsatzsteuer 19%",
    });
  });

  it("labels names of business objects by kind and keeps codes", () => {
    const scrubbed = scrubber().scrub({
      objects: [
        { objectName: "Part", name: "Beratung Huber", partNumber: "ART-77", price: "49.99" },
        { objectName: "InvoicePos", name: "Montage bei Huber", text: "<p>Details</p>" },
        { objectName: "CheckAccount", name: "Sparkasse Giro", type: "online", iban: null },
      ],
    });
    expect(scrubbed).toEqual({
      objects: [
        { objectName: "Part", name: "Musterartikel 1", partNumber: "ART-01", price: "49.99" },
        { objectName: "InvoicePos", name: "Musterposition 1", text: "Muster-Text 1" },
        { objectName: "CheckAccount", name: "Musterkonto 1", type: "online", iban: null },
      ],
    });
  });

  it("replaces PDF content with a tiny fake PDF and reduces XML to its root element", () => {
    const pdf = loadFixture("documents/invoice-pdf.json").body;
    const scrubbedPdf = scrubber().scrub(pdf) as { objects: Record<string, unknown> };
    expect(scrubbedPdf.objects["content"]).toBe(FAKE_PDF_BASE64);
    expect(scrubbedPdf.objects["mimeType"]).toBe("application/pdf");
    expect(Buffer.from(FAKE_PDF_BASE64, "base64").toString("latin1")).toMatch(/^%PDF-1\.4/);

    const xml = loadFixture("documents/invoice-xml.json").body as { objects: string };
    const scrubbedXml = scrubber().scrub(xml) as { objects: string };
    expect(scrubbedXml.objects).toMatch(
      /^<\?xml version="1.0" encoding="UTF-8"\?>\n<rsm:CrossIndustryInvoice /,
    );
    expect(scrubbedXml.objects).toContain('xmlns:rsm="');
    expect(scrubbedXml.objects).toContain("</rsm:CrossIndustryInvoice>");
    expect(scrubbedXml.objects).not.toContain("Musterfirma");
    expect(scrubbedXml.objects.length).toBeLessThan(xml.objects.length);
  });

  it("finds the XML root after comments, processing instructions and a DOCTYPE", () => {
    const decl = '<?xml version="1.0" encoding="UTF-8"?>';
    const xml = (body: string): string =>
      (scrubber().scrub({ objects: `${decl}${body}` }) as { objects: string }).objects;

    const scrubbed = xml(
      '\n<!-- <fake:Root> Musterfirma --><?pi data?>\n<!DOCTYPE x>\n<ubl:Invoice xmlns:ubl="urn:x"><cbc:Name>Musterfirma</cbc:Name></ubl:Invoice>',
    );
    expect(scrubbed).toMatch(/\n<ubl:Invoice xmlns:ubl="urn:x">\n/);
    expect(scrubbed).not.toContain("fake:Root");
    expect(scrubbed).not.toContain("Musterfirma");

    for (const broken of ["<!-- never closed <a:Root>", "<?pi never closed", "plain text"]) {
      expect(xml(broken)).toMatch(/<!-- scrubbed: \d+ characters -->$/);
      expect(xml(broken)).not.toContain("a:Root");
    }
  });

  it("scrubs unknown free text by default and reports the key for review", () => {
    const s = scrubber();
    const scrubbed = s.scrub({
      objects: { somethingNew: "Frau Meier anrufen", code: "AB-1", flag: "1", mystery: "XY" },
    });
    expect(scrubbed).toEqual({
      objects: { somethingNew: "Muster-Text 1", code: "AB-1", flag: "1", mystery: "XY" },
    });
    expect(s.stats().defaultedKeys).toEqual(["somethingNew"]);
  });

  it("catches e-mails, phones, VAT ids and IBANs under unknown keys", () => {
    const scrubbed = scrubber().scrub({
      a: "kontakt@huber.de",
      b: "+49 (89) 123 456 78",
      c: "DE123456789",
      d: "DE89 3704 0044 0532 0130 00",
      e: "10.0.0.7",
    });
    expect(scrubbed).toEqual({
      a: "person1@example.com",
      b: "+49 30 0000001",
      c: "DE000000001",
      d: "DE00000000000000000001",
      e: "192.0.2.2",
    });
  });

  it("redacts passwords and PINs and never mutates its input", () => {
    const input = { objects: { objectName: "CheckAccount", pin: "1234", smtpPassword: "pw" } };
    const copy = structuredClone(input);
    expect(scrubber().scrub(input)).toEqual({
      objects: { objectName: "CheckAccount", pin: REDACTED, smtpPassword: REDACTED },
    });
    expect(input).toEqual(copy);
  });

  it("scrubText keeps error wording and removes contact data and the token", () => {
    const s = scrubber();
    expect(s.scrubText(`Contact info@huber.de not found (${TOKEN})`)).toBe(
      `Contact person1@example.com not found (${REDACTED})`,
    );
  });
});

describe("assertNoSecrets", () => {
  it("throws without echoing the secret", () => {
    expect(() => {
      assertNoSecrets(`{"x":"${TOKEN}"}`, [TOKEN]);
    }).toThrow(/still contains a secret/);
    try {
      assertNoSecrets(TOKEN, [TOKEN]);
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
  });

  it("ignores empty secrets", () => {
    expect(() => {
      assertNoSecrets("anything", [""]);
    }).not.toThrow();
  });
});
