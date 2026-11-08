/**
 * M4 probes for e-invoices (E-Rechnung, XRechnung, ZUGFeRD/Factur-X):
 *
 * - `write-einvoice-xml` (opt-in, it finalizes an invoice): an invoice draft with
 *   `propertyIsEInvoice: true` for a tagged contact with buyer reference and e-mail, finalized with
 *   `sendBy`; then `getXml` (syntax, profile BT-24) and `getPdf` (is the XML embedded?). The XML is
 *   attached to the report as a fixture candidate, scrubbed by {@link scrubEInvoiceXml}.
 * - `write-voucher-zugferd-upload`: a generated Factur-X PDF (one page plus `factur-x.xml`, EN 16931
 *   CII) uploaded as a receipt; does sevDesk take anything from the XML?
 *
 * The fixture scrubber keeps the element structure, codes, amounts, dates and the profile, and
 * replaces names, addresses, contact data, bank and tax ids, document numbers and free text with
 * the run scrubber's fakes. Its output has no XML declaration and no `http(s)://`: the runner
 * scrubs attachments again with `scrubText`, which would cut a declared XML down to its root
 * element and would eat a URL up to the next blank, closing tags included.
 */
import type { Scrubber } from "../scrub.js";
import { addDays, createdId, type ProbeContext, type ProbeDefinition, str } from "./core.js";
import {
  compactDate,
  createVoucher,
  data,
  describeUpload,
  firstRow,
  inconclusive,
  outcomeOf,
  shapeOf,
  slug,
  tinyPdf,
  uploadTempFile,
  voucherFailure,
  voucherPositions,
} from "./m4-shared-probes.js";

// ---------------------------------------------------------------------------------------------
// Factur-X test file
// ---------------------------------------------------------------------------------------------

/** What the generated Factur-X invoice says (deliberately different from the voucher we save). */
export interface FacturXContent {
  readonly seller: string;
  readonly number: string;
  /** YYYY-MM-DD */
  readonly issueDate: string;
  readonly dueDate: string;
}

/**
 * A minimal CII invoice: one line of 200.00 net at 19 %, 238.00 gross. `en16931` is a Factur-X
 * EN 16931 profile; `xrechnung` adds what XRechnung 3.0 demands (BT-10 buyer reference, seller
 * contact BG-6, electronic addresses BT-34/BT-49, SEPA transfer with IBAN, payment terms) under
 * the XRechnung specification id. All values are fakes.
 */
export function facturXml(
  content: FacturXContent,
  profile: "en16931" | "xrechnung" = "en16931",
): string {
  const xrechnung = profile === "xrechnung";
  const date = (value: string) =>
    `<udt:DateTimeString format="102">${compactDate(value)}</udt:DateTimeString>`;
  const address = (street: string) =>
    `<ram:PostalTradeAddress><ram:PostcodeCode>10115</ram:PostcodeCode><ram:LineOne>${street}</ram:LineOne>` +
    "<ram:CityName>Berlin</ram:CityName><ram:CountryID>DE</ram:CountryID></ram:PostalTradeAddress>";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">',
    "<rsm:ExchangedDocumentContext>" +
      (xrechnung
        ? "<ram:BusinessProcessSpecifiedDocumentContextParameter><ram:ID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</ram:ID></ram:BusinessProcessSpecifiedDocumentContextParameter>"
        : "") +
      `<ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>${xrechnung ? XRECHNUNG_ID : "urn:cen.eu:en16931:2017"}</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>`,
    `<rsm:ExchangedDocument><ram:ID>${content.number}</ram:ID><ram:TypeCode>380</ram:TypeCode><ram:IssueDateTime>${date(content.issueDate)}</ram:IssueDateTime></rsm:ExchangedDocument>`,
    "<rsm:SupplyChainTradeTransaction>",
    "<ram:IncludedSupplyChainTradeLineItem><ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>",
    "<ram:SpecifiedTradeProduct><ram:Name>Büromaterial</ram:Name></ram:SpecifiedTradeProduct>",
    "<ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>200.00</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>",
    '<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="C62">1</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>',
    "<ram:SpecifiedLineTradeSettlement><ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>19</ram:RateApplicablePercent></ram:ApplicableTradeTax>",
    "<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>200.00</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation></ram:SpecifiedLineTradeSettlement>",
    "</ram:IncludedSupplyChainTradeLineItem>",
    "<ram:ApplicableHeaderTradeAgreement>",
    xrechnung ? `<ram:BuyerReference>${content.number}-REF</ram:BuyerReference>` : "",
    `<ram:SellerTradeParty><ram:Name>${content.seller}</ram:Name>` +
      (xrechnung
        ? "<ram:DefinedTradeContact><ram:PersonName>Max Mustermann</ram:PersonName>" +
          "<ram:TelephoneUniversalCommunication><ram:CompleteNumber>+49 30 0000000</ram:CompleteNumber></ram:TelephoneUniversalCommunication>" +
          "<ram:EmailURIUniversalCommunication><ram:URIID>seller@example.org</ram:URIID></ram:EmailURIUniversalCommunication></ram:DefinedTradeContact>"
        : "") +
      address("Musterstraße 1") +
      (xrechnung ? electronicAddress("seller@example.org") : "") +
      '<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE000000001</ram:ID></ram:SpecifiedTaxRegistration></ram:SellerTradeParty>',
    `<ram:BuyerTradeParty><ram:Name>Musterfirma GmbH</ram:Name>${address("Musterstraße 2")}${xrechnung ? electronicAddress("buyer@example.org") : ""}</ram:BuyerTradeParty>`,
    "</ram:ApplicableHeaderTradeAgreement>",
    `<ram:ApplicableHeaderTradeDelivery><ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime>${date(content.issueDate)}</ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent></ram:ApplicableHeaderTradeDelivery>`,
    "<ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>",
    xrechnung
      ? "<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>DE02120300000000202051</ram:IBANID></ram:PayeePartyCreditorFinancialAccount></ram:SpecifiedTradeSettlementPaymentMeans>"
      : "",
    "<ram:ApplicableTradeTax><ram:CalculatedAmount>38.00</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode><ram:BasisAmount>200.00</ram:BasisAmount><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>19</ram:RateApplicablePercent></ram:ApplicableTradeTax>",
    `<ram:SpecifiedTradePaymentTerms>${xrechnung ? "<ram:Description>Zahlbar innerhalb von 14 Tagen</ram:Description>" : ""}<ram:DueDateDateTime>${date(content.dueDate)}</ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>`,
    "<ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:LineTotalAmount>200.00</ram:LineTotalAmount><ram:TaxBasisTotalAmount>200.00</ram:TaxBasisTotalAmount>",
    '<ram:TaxTotalAmount currencyID="EUR">38.00</ram:TaxTotalAmount><ram:GrandTotalAmount>238.00</ram:GrandTotalAmount><ram:DuePayableAmount>238.00</ram:DuePayableAmount>',
    "</ram:SpecifiedTradeSettlementHeaderMonetarySummation></ram:ApplicableHeaderTradeSettlement>",
    "</rsm:SupplyChainTradeTransaction>",
    "</rsm:CrossIndustryInvoice>",
    "",
  ]
    .filter((line, index, lines) => line !== "" || index === lines.length - 1)
    .join("\n");
}

/** BT-24 of XRechnung 3.0 (CIUS of EN 16931). */
const XRECHNUNG_ID = "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0";

/** An electronic address (BT-34/BT-49) as an e-mail (scheme EM). */
function electronicAddress(email: string): string {
  return `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${email}</ram:URIID></ram:URIUniversalCommunication>`;
}

/** XMP metadata that declares the Factur-X attachment (EN 16931 conformance level). */
export const FACTUR_X_XMP = [
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
  '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
  '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description>',
  '<rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">',
  "<fx:DocumentType>INVOICE</fx:DocumentType><fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>",
  "<fx:Version>1.0</fx:Version><fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>",
  "</rdf:Description>",
  "</rdf:RDF>",
  "</x:xmpmeta>",
  '<?xpacket end="w"?>',
].join("\n");

// ---------------------------------------------------------------------------------------------
// XML: syntax, profile, fixture scrubbing
// ---------------------------------------------------------------------------------------------

const PREFIX = String.raw`(?:[\w.-]+:)?`;

/** Syntax (UBL or CII), root element, BT-24 profile and the XML declaration of an e-invoice. */
export function eInvoiceSyntax(xml: string): {
  readonly syntax: "UBL" | "CII" | "unknown";
  readonly root: string;
  readonly profile: string | undefined;
  readonly declaration: string | undefined;
} {
  const declaration = /^\s*(<\?xml[^>]*\?>)/.exec(xml)?.[1];
  const root =
    /<([A-Za-z_][\w.:-]*)[\s>]/.exec(xml.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, ""))?.[1] ?? "";
  const local = root.slice(root.indexOf(":") + 1);
  const syntax =
    local === "CrossIndustryInvoice"
      ? "CII"
      : (local === "Invoice" || local === "CreditNote") && /ubl/i.test(xml.slice(0, 2000))
        ? "UBL"
        : "unknown";
  const profile =
    syntax === "UBL"
      ? new RegExp(`<${PREFIX}CustomizationID[^>]*>([^<]*)<`).exec(xml)?.[1]
      : new RegExp(
          `<${PREFIX}GuidelineSpecifiedDocumentContextParameter[^>]*>\\s*<${PREFIX}ID[^>]*>([^<]*)<`,
        ).exec(xml)?.[1];
  return { syntax, root, profile: profile?.trim(), declaration };
}

/** Elements whose text is a code, an amount, a date or a quantity: kept when it looks like one. */
const CODE_ELEMENTS = new Set([
  "CustomizationID",
  "ProfileID",
  "TypeCode",
  "InvoiceTypeCode",
  "CreditNoteTypeCode",
  "DocumentCurrencyCode",
  "InvoiceCurrencyCode",
  "TaxCurrencyCode",
  "CountryID",
  "IdentificationCode",
  "CategoryCode",
  "ExemptionReasonCode",
  "TaxExemptionReasonCode",
  "PaymentMeansCode",
  "UnitCode",
  "LineID",
  "RateApplicablePercent",
  "Percent",
  "CalculationPercent",
  "ReasonCode",
  "ChargeIndicator",
  "Indicator",
  "DateTimeString",
  "IssueDate",
  "DueDate",
  "TaxPointDate",
  "StartDate",
  "EndDate",
  "ActualDeliveryDate",
  "BilledQuantity",
  "InvoicedQuantity",
  "CreditedQuantity",
  "BaseQuantity",
  "BasisQuantity",
]);

const CODE_TEXT = /^[\w.:+/#%-]{1,120}$/;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$|^\d{8}$/;
const UPPER_CODE = /^[A-Z0-9][A-Z0-9_./%:-]{0,15}$/;

type TextRule = "keep" | "base64" | "generic" | { readonly key: string };

/** How the text of `local` (with its parent, root depth and attributes) is scrubbed. */
function textRule(
  local: string,
  parent: string,
  depth: number,
  attributes: Readonly<Record<string, string>>,
): TextRule {
  const key = (name: string): TextRule => ({ key: name });
  if (
    local === "ID" &&
    /^(?:Guideline|BusinessProcess)SpecifiedDocumentContextParameter$/.test(parent)
  ) {
    return "keep";
  }
  if (CODE_ELEMENTS.has(local) || local.endsWith("Amount")) return "keep";
  if (local === "ID" && /^(?:TaxCategory|ClassifiedTaxCategory|TaxScheme)$/.test(parent)) {
    return "keep";
  }
  if (local === "EmbeddedDocumentBinaryObject" || local === "AttachmentBinaryObject") {
    return "base64";
  }
  if (local === "Name") {
    if (parent === "SpecifiedTradeProduct" || parent === "Item") return key("text");
    if (parent === "Contact" || parent === "DefinedTradeContact") return key("fullname");
    return key("name");
  }
  switch (local) {
    case "RegistrationName":
    case "TradingBusinessName":
    case "AccountName":
      return key("name");
    case "PersonName":
      return key("fullname");
    case "LineOne":
    case "LineTwo":
    case "LineThree":
    case "StreetName":
    case "AdditionalStreetName":
    case "Line":
    case "BuildingNumber":
      return key("street");
    case "PostcodeCode":
    case "PostalZone":
      return key("zip");
    case "CityName":
    case "CitySubdivisionName":
    case "CountrySubentity":
    case "CountrySubDivisionName":
      return key("city");
    case "URIID":
    case "EndpointID":
      return key("value");
    case "CompleteNumber":
    case "Telephone":
      return key("phone");
    case "ElectronicMail":
      return key("email");
    case "IBANID":
    case "ProprietaryID":
      return key("iban");
    case "BICID":
      return key("bic");
    case "BuyerReference":
      return key("buyerReference");
    case "IssuerAssignedID":
      return key("orderNumber");
    case "PaymentReference":
    case "PaymentID":
    case "InstructionNote":
      return key("purpose");
    case "Note":
    case "Content":
    case "Description":
    case "Information":
    case "DepartmentName":
      return key("text");
    case "CompanyID":
      return parent === "PartyTaxScheme" ? key("vatId") : key("customerNumber");
    case "GlobalID":
      return key("customerNumber");
    default:
      break;
  }
  if (local === "ID") {
    if (parent === "PayeeFinancialAccount") return key("iban");
    if (parent === "FinancialInstitutionBranch" || parent === "FinancialInstitution") {
      return key("bic");
    }
    if (parent === "SpecifiedTaxRegistration") {
      return key(attributes["schemeID"] === "FC" ? "taxNumber" : "vatId");
    }
    if (parent === "ExchangedDocument" || depth === 1) return key("invoiceNumber");
    return key("customerNumber");
  }
  return "generic";
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const localName = (name: string) => name.slice(name.indexOf(":") + 1);

/**
 * A fixture candidate from a real e-invoice: the element structure, namespaces (except `xsi`),
 * codes, amounts, dates and the profile stay; personal and company data and free text become the
 * run scrubber's fakes; embedded files become a base64 placeholder. No XML declaration, no
 * comments or processing instructions, and no `http(s)://` in the output.
 */
export function scrubEInvoiceXml(xml: string, scrubber: Scrubber): string {
  const fake = (key: string, value: string): string => {
    const scrubbed = (scrubber.scrub({ [key]: value }) as Record<string, unknown>)[key];
    return escapeXml(typeof scrubbed === "string" ? scrubbed : "x");
  };
  const stack: { readonly local: string; readonly attributes: Record<string, string> }[] = [];
  const out: string[] = [];
  const tokens =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/[^>]+>|<[A-Za-z_][^>]*>|[^<]+/g;
  for (const match of xml.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith("<!--") || token.startsWith("<?") || /^<![^[]/.test(token)) continue;
    if (token.startsWith("</")) {
      stack.pop();
      out.push(token);
      continue;
    }
    if (token.startsWith("<") && !token.startsWith("<![CDATA[")) {
      const name = /^<([A-Za-z_][\w.:-]*)/.exec(token)?.[1] ?? "x";
      const selfClosing = token.endsWith("/>");
      const attributes: Record<string, string> = {};
      const kept: string[] = [];
      for (const attribute of token.matchAll(
        /\s([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
      )) {
        const attributeName = attribute[1] ?? "";
        const value = attribute[2] ?? attribute[3] ?? "";
        attributes[attributeName] = value;
        if (attributeName === "xmlns:xsi" || attributeName.startsWith("xsi:")) continue;
        if (/https?:\/\//i.test(value)) continue;
        const safe =
          attributeName === "filename"
            ? fake("filename", value)
            : CODE_TEXT.test(value) || value === ""
              ? value
              : "x";
        kept.push(` ${attributeName}="${safe}"`);
      }
      out.push(`<${name}${kept.join("")}${selfClosing ? "/>" : ">"}`);
      if (!selfClosing) stack.push({ local: localName(name), attributes });
      continue;
    }
    const value = match[1] ?? token;
    if (value.trim() === "") {
      out.push(value);
      continue;
    }
    const top = stack.at(-1);
    const rule = textRule(
      top?.local ?? "",
      stack.at(-2)?.local ?? "",
      stack.length - 1,
      top?.attributes ?? {},
    );
    const text = value.trim();
    if (rule === "base64") out.push("c2NydWJiZWQ=");
    else if (rule === "keep") out.push(CODE_TEXT.test(text) ? text : fake("text", text));
    else if (rule === "generic") {
      const keep =
        NUMERIC.test(text) ||
        DATE_TEXT.test(text) ||
        UPPER_CODE.test(text) ||
        text.startsWith("urn:");
      out.push(keep ? text : fake("text", text));
    } else out.push(fake(rule.key, text));
  }
  return out
    .join("")
    .replace(/https?:\/\//gi, "")
    .trimStart();
}

// ---------------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------------

/** Keys of the uploadTempFile answer seen so far (`isEInvoice` recorded 2026-11-08). */
const KNOWN_UPLOAD_KEYS: readonly string[] = [
  "pages",
  "mimeType",
  "originMimeType",
  "filename",
  "contentHash",
  "content",
  "isEInvoice",
];

/** The `sevClient` fields an e-invoice needs per the spec (`propertyIsEInvoice`). */
const SEV_CLIENT_FIELDS = [
  "addressStreet",
  "addressZip",
  "addressCity",
  "bankIban",
  "bankBic",
  "contactEmail",
  "contactPhone",
  "taxNumber",
  "vatNumber",
] as const;

/** The XML text of a getXml answer: a JSON string, a JSON object with the XML, or raw XML. */
export function xmlFromAnswer(bytes: Uint8Array | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  const text = new TextDecoder().decode(bytes);
  if (text.trimStart().startsWith("<")) return text;
  try {
    const objects = (JSON.parse(text) as { objects?: unknown }).objects;
    if (typeof objects === "string") return objects;
    const row = firstRow(objects);
    for (const key of ["xml", "content"]) {
      const value = row?.[key];
      if (typeof value !== "string") continue;
      if (value.trimStart().startsWith("<")) return value;
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
      );
      if (decoded.trimStart().startsWith("<")) return decoded;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Whether a PDF (bytes) embeds files, and the names of embedded `.xml` files. */
export function embeddedXmlNames(pdf: Uint8Array): { embedded: boolean; names: string[] } {
  const text = new TextDecoder("latin1").decode(pdf);
  const names = [...text.matchAll(/\(([\w.-]+\.xml)\)/g)].map((match) => match[1] ?? "");
  return { embedded: text.includes("/EmbeddedFiles"), names: [...new Set(names)] };
}

/** The PDF bytes of a getPdf JSON answer (`content`, base64), if any. */
function pdfFromAnswer(bytes: Uint8Array | undefined): Uint8Array | undefined {
  if (bytes === undefined) return undefined;
  try {
    const row = firstRow(
      (JSON.parse(new TextDecoder().decode(bytes)) as { objects?: unknown }).objects,
    );
    const content = row?.["content"];
    return typeof content === "string"
      ? Uint8Array.from(atob(content), (char) => char.charCodeAt(0))
      : undefined;
  } catch {
    return undefined;
  }
}

async function eInvoiceContact(
  ctx: ProbeContext,
): Promise<{ readonly id: number | undefined; readonly note: string }> {
  const tag = data(ctx).tag;
  const contact = await ctx.http.write("POST", "/Contact", {
    tier: "write",
    body: {
      name: `${tag} E-Rechnung`,
      category: { id: 3, objectName: "Category" },
      status: 1000,
      buyerReference: `${slug(tag)}-REF`,
    },
  });
  const id = createdId(contact.objects);
  if (id === undefined) return { id, note: `contact ${outcomeOf(contact)}` };
  data(ctx).register("Contact", id, "active (can be deleted in the web app)");
  const email = await ctx.http.write("POST", "/CommunicationWay", {
    tier: "write",
    body: {
      contact: { id, objectName: "Contact" },
      type: "EMAIL",
      value: "einvoice-probe@example.org",
      key: { id: 2, objectName: "CommunicationWayKey" },
      main: true,
    },
  });
  const row = await ctx.read.byId("Contact", id, { depth: 1 });
  return {
    id,
    note: `contact ${id}: buyerReference kept ${str(row, "buyerReference") !== ""}, e-mail ${outcomeOf(email)}`,
  };
}

export const M4_EINVOICE_PROBES: readonly ProbeDefinition[] = [
  {
    id: "write-einvoice-xml",
    title: "An e-invoice (propertyIsEInvoice) finalized, then getXml and getPdf",
    mode: "write",
    optIn: true,
    question:
      "Does an invoice draft with propertyIsEInvoice: true (contact with buyerReference and e-mail, payment method, address) finalize with sendBy (or which data does sevDesk demand), which syntax (UBL or CII) and profile (BT-24) does GET /Invoice/{id}/getXml answer, and does getPdf embed the XML (ZUGFeRD)? Finalizes one invoice, so it runs only with --only. The scrubbed XML is attached to the report as a fixture candidate.",
    deviations: ["D-033", "D-034", "NEW"],
    async run(ctx) {
      const client = await ctx.http.get("/SevClient");
      const clientRow = client.ok ? firstRow(client.objects) : undefined;
      const missing = SEV_CLIENT_FIELDS.filter((key) => str(clientRow, key) === "");
      const preflight = `account fields empty or absent: ${missing.join(", ") || "none"}`;

      const methods = await ctx.read.page("/PaymentMethod", undefined, 100);
      const method =
        methods.rows.find((row) => str(row, "electronicInvoiceId") === "58") ?? methods.rows[0];
      const methodId = Number(method?.["id"]);
      if (!Number.isSafeInteger(methodId)) return inconclusive(`No payment method. ${preflight}.`);

      const contact = await eInvoiceContact(ctx);
      if (contact.id === undefined)
        return inconclusive(`Could not prepare: ${contact.note}. ${preflight}.`);
      const tag = data(ctx).tag;
      const draft = await data(ctx).draft("Invoice", {
        fields: {
          contact: { id: contact.id, objectName: "Contact" },
          propertyIsEInvoice: true,
          paymentMethod: { id: methodId, objectName: "PaymentMethod" },
          addressName: `${tag} E-Rechnung Kunde`,
          addressStreet: "Musterstraße 1",
          addressZip: "10115",
          addressCity: "Berlin",
        },
      });
      if (draft.id === undefined) {
        return {
          verdict: "observed",
          finding: `The e-invoice draft was ${outcomeOf(draft.result)}. ${contact.note}; ${preflight}.`,
        };
      }
      const id = draft.id;
      const asDraft = await ctx.read.byId("Invoice", id);
      const flag = `propertyIsEInvoice on read ${Object.hasOwn(asDraft ?? {}, "propertyIsEInvoice") ? JSON.stringify(asDraft?.["propertyIsEInvoice"]) : "absent"}`;
      const finalized = await data(ctx).finalize("Invoice", id);
      if (!finalized.ok) {
        return {
          verdict: "observed",
          finding: `Draft ${id} saved (${flag}); sendBy ${outcomeOf(finalized)}. ${contact.note}; ${preflight}.`,
          deviations: { "D-034": "informs" },
        };
      }
      const xml = await ctx.http.get(`/Invoice/${id}/getXml`);
      const text = xml.ok ? xmlFromAnswer(xml.bytes) : undefined;
      const pdf = await ctx.http.get(`/Invoice/${id}/getPdf`, { preventSendBy: "true" });
      const pdfBytes = pdf.ok ? pdfFromAnswer(pdf.bytes) : undefined;
      const embedded = pdfBytes === undefined ? undefined : embeddedXmlNames(pdfBytes);
      const pdfNote =
        embedded === undefined
          ? `getPdf ${pdf.ok ? "answered no PDF content" : outcomeOf(pdf)}`
          : `getPdf: ${embedded.embedded ? `embeds files (${embedded.names.join(", ") || "no .xml name found"})` : "no embedded files"}`;
      if (text === undefined) {
        return {
          verdict: "observed",
          finding: `Invoice ${id} finalized (${flag}); getXml ${xml.ok ? `answered no XML (${shapeOf(xml.objects)}, Content-Type ${xml.contentType ?? "none"})` : outcomeOf(xml)}. ${pdfNote}.`,
          deviations: { "D-033": "informs", "D-034": "informs" },
        };
      }
      const syntax = eInvoiceSyntax(text);
      return {
        verdict: "observed",
        finding:
          `Invoice ${id} finalized (${flag}). getXml: Content-Type ${xml.contentType ?? "none"}, ${xml.json === undefined ? "raw XML" : "XML inside JSON"}, ` +
          `${text.length} characters, ${syntax.syntax} (root ${syntax.root}), profile BT-24 ${JSON.stringify(syntax.profile ?? null)}, ` +
          `declaration ${JSON.stringify(syntax.declaration ?? null)}. ${pdfNote}. ${contact.note}; ${preflight}.`,
        deviations: { "D-033": "informs", "D-034": "informs" },
        attachments: [
          {
            label: `Fixture candidate: getXml of e-invoice ${id} (${syntax.syntax}, scrubbed; add the declaration back)`,
            language: "xml",
            content: scrubEInvoiceXml(text, ctx.scrubber),
          },
        ],
      };
    },
  },
  {
    id: "write-voucher-upload-xml",
    title: "uploadTempFile with an XRechnung (CII XML) file",
    mode: "write",
    question:
      "Does POST /Voucher/Factory/uploadTempFile take a small valid XRechnung 3.0 CII XML (application/xml, file name x.xml), with which answer (keys, mimeType, isEInvoice), or refuse it (415 like plain text)? If it takes it: does a draft voucher saved with that token get a document?",
    deviations: ["D-011", "B6", "NEW"],
    async run(ctx) {
      const tag = data(ctx).tag;
      const xml = facturXml(
        {
          seller: `${tag} XML-Lieferant GmbH`,
          number: `${slug(tag)}-XR1`,
          issueDate: ctx.today,
          dueDate: addDays(ctx.today, 14),
        },
        "xrechnung",
      );
      const bytes = new TextEncoder().encode(xml);
      const upload = await uploadTempFile(ctx, bytes, "x.xml", "application/xml");
      if (upload.token === undefined) {
        return {
          verdict: "observed",
          finding: `XRechnung CII (${bytes.length} bytes, application/xml): ${upload.result.ok ? `accepted without a token (${describeUpload(upload.result.objects)})` : outcomeOf(upload.result)}.`,
          deviations: { B6: "informs" },
        };
      }
      const created = await createVoucher(ctx, {
        label: "XRechnung upload",
        file: { token: upload.token, placement: "top-level" },
      });
      if (created.id === undefined) {
        return {
          verdict: "observed",
          finding: `Upload accepted (${describeUpload(upload.result.objects)}); saveVoucher with its token: ${voucherFailure(created)}.`,
          deviations: { B6: "informs" },
        };
      }
      const row = await ctx.read.byId("Voucher", created.id);
      const document =
        row !== undefined && Object.hasOwn(row, "document")
          ? JSON.stringify(row["document"])
          : "absent";
      return {
        verdict: "observed",
        finding:
          `XRechnung CII (${bytes.length} bytes, application/xml): accepted, ${describeUpload(upload.result.objects)}. ` +
          `Draft voucher ${created.id} with the token: status ${str(row, "status")}, document ${document}, supplierName ${str(row, "supplierName") === `${tag} Lieferant` ? "as sent" : "changed"}.`,
        deviations: { B6: "informs" },
      };
    },
  },
  {
    id: "write-voucher-zugferd-upload",
    title: "A Factur-X/ZUGFeRD PDF as a receipt: does sevDesk read the XML?",
    mode: "write",
    question:
      "When a generated Factur-X PDF (one page plus factur-x.xml, EN 16931 CII: other supplier, number, date, due date and 238.00 gross) is uploaded with uploadTempFile and saved as a draft voucher (supplierName, 119.00 gross, today), does the upload answer or the saved voucher show anything taken from the XML (expected: nothing)? What is the upload answer's isEInvoice for it and for a plain PDF, and does the voucher carry an e-invoice key?",
    deviations: ["B6", "D-011", "NEW"],
    async run(ctx) {
      const tag = data(ctx).tag;
      const content: FacturXContent = {
        seller: `${tag} XML-Lieferant GmbH`,
        number: `${slug(tag)}-ZF1`,
        issueDate: addDays(ctx.today, -5),
        dueDate: addDays(ctx.today, 9),
      };
      const pdf = await tinyPdf(
        [`${tag} ZUGFeRD`, `Rechnung ${content.number}`, "Factur-X EN 16931, 238,00 EUR"],
        { name: "factur-x.xml", xml: facturXml(content), xmp: FACTUR_X_XMP },
      );
      // A plain receipt PDF first, to compare the upload answer's isEInvoice.
      const plain = await uploadTempFile(
        ctx,
        await tinyPdf([`${tag} plain receipt`, "Bürobedarf 119,00 EUR"]),
        `${slug(tag)}-plain.pdf`,
        "application/pdf",
      );
      const upload = await uploadTempFile(ctx, pdf, `${slug(tag)}-zugferd.pdf`, "application/pdf");
      if (upload.token === undefined) {
        return inconclusive(`uploadTempFile ${outcomeOf(upload.result)}, no token.`);
      }
      const flagOf = (objects: unknown): string => {
        const answer = firstRow(objects);
        return answer !== undefined && Object.hasOwn(answer, "isEInvoice")
          ? JSON.stringify(answer["isEInvoice"])
          : "absent";
      };
      const uploadKeys = Object.keys(firstRow(upload.result.objects) ?? {});
      const extraKeys = uploadKeys.filter((key) => !KNOWN_UPLOAD_KEYS.includes(key));
      const created = await createVoucher(ctx, {
        label: "ZUGFeRD",
        file: { token: upload.token, placement: "top-level" },
      });
      if (created.id === undefined) return inconclusive(voucherFailure(created));
      const row = await ctx.read.byId("Voucher", created.id);
      const positions = await voucherPositions(ctx, created.id);
      const fromXml: string[] = [];
      const check = (label: string, value: string, xmlValue: string) => {
        if (value !== "" && value.includes(xmlValue)) fromXml.push(`${label} ${value}`);
      };
      check("supplierName", str(row, "supplierName"), "XML-Lieferant");
      check("description", str(row, "description"), "ZF1");
      check("voucherDate", str(row, "voucherDate"), content.issueDate);
      check("paymentDeadline", str(row, "paymentDeadline"), content.dueDate);
      check("sumGross", str(row, "sumGross"), "238");
      const positionsFromXml = positions.length !== 1;
      const document =
        row !== undefined && Object.hasOwn(row, "document")
          ? JSON.stringify(row["document"])
          : "absent";
      const voucherFlags = Object.entries(row ?? {})
        .filter(([key]) => /e-?invoice|xrechnung|zugferd|facturx/i.test(key))
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
      return {
        verdict: fromXml.length === 0 && !positionsFromXml ? "confirmed" : "contradicted",
        finding:
          `isEInvoice in the upload answer: plain PDF ${plain.result.ok ? flagOf(plain.result.objects) : outcomeOf(plain.result)}, ` +
          `Factur-X PDF ${flagOf(upload.result.objects)}. ` +
          `Upload of ${pdf.length} bytes: ${describeUpload(upload.result.objects)}${extraKeys.length > 0 ? `; keys beyond the known ones: ${extraKeys.join(", ")}` : ""}. ` +
          `Voucher ${created.id}: supplierName ${JSON.stringify(str(row, "supplierName") === `${tag} Lieferant` ? "as sent" : "changed")}, ` +
          `sumGross ${str(row, "sumGross")}, voucherDate ${str(row, "voucherDate")}, paymentDeadline ${str(row, "paymentDeadline") || "none"}, ` +
          `document ${document}, ${positions.length} position(s), e-invoice keys on the voucher: ${voucherFlags.join(", ") || "none"}. ` +
          `Taken from the XML: ${fromXml.join(", ") || "nothing"}.`,
        deviations: { B6: "informs" },
      };
    },
  },
];
