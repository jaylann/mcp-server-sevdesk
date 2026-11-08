/**
 * Reads a UN/CEFACT Cross Industry Invoice (CII, D16B as profiled by EN 16931-3-3) into the
 * e-invoice model: the syntax of XRechnung CII and of the XML inside ZUGFeRD 2.x / Factur-X PDFs.
 * The root element is `rsm:CrossIndustryInvoice` in the namespace
 * `urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100`.
 *
 * Paths follow the EN 16931-3-3 syntax binding (BT id → CII element). Only the business terms of
 * the model are read; extensions (EXTENDED profile sub-lines, logistics data) are ignored. ZUGFeRD
 * 1.0 (`CrossIndustryDocument`) is a different, older format and is refused in `parse.ts`.
 */
import { CREDIT_TRANSFER_MEANS, documentKindOf, profileOf } from "./codes.js";
import { pricePerUnit } from "./decimal.js";
import {
  completeTotals,
  type EInvoiceContent,
  type ExtractedEInvoice,
  type RawTotals,
} from "./extracted.js";
import {
  FieldReader,
  MAX_LINES,
  MAX_NOTES,
  MAX_ROWS,
  normalizeIban,
  normalizeVatId,
  partyOf,
  requireCurrency,
  requireVatCategory,
  TEXT_CAPS,
  unreadable,
  withoutUndefined,
} from "./fields.js";
import type { EInvoiceLine, EInvoiceParty } from "./model.js";
import { at, attribute, child, childrenNamed, textAt, type XmlElement } from "./xml.js";

/** Namespace URI of the CII root element (EN 16931-3-3, D16B). */
export const CII_NAMESPACE = "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100";

/** Reads a `CrossIndustryInvoice` root element. */
export function readCii(root: XmlElement): ExtractedEInvoice {
  const fields = new FieldReader();
  const context = at(root, "ExchangedDocumentContext");
  const document = at(root, "ExchangedDocument");
  const transaction = at(root, "SupplyChainTradeTransaction");
  const agreement = at(transaction, "ApplicableHeaderTradeAgreement");
  const delivery = at(transaction, "ApplicableHeaderTradeDelivery");
  const settlement = at(transaction, "ApplicableHeaderTradeSettlement");

  const specificationId = fields.text(
    textAt(context, "GuidelineSpecifiedDocumentContextParameter", "ID"),
    TEXT_CAPS.specification,
  );
  const number = fields.text(textAt(document, "ID"), TEXT_CAPS.identifier);
  if (number === undefined) throw unreadable("The e-invoice has no invoice number (BT-1, BR-02)");
  const typeCode = fields.code(textAt(document, "TypeCode"));
  if (typeCode === undefined) {
    throw unreadable("The e-invoice has no valid invoice type code (BT-3, BR-04)");
  }
  const issueDate = ciiDate(fields, at(document, "IssueDateTime"), "The issue date (BT-2)");
  if (issueDate === undefined) {
    throw unreadable("The e-invoice has no readable issue date (BT-2, BR-03)");
  }
  const currency = requireCurrency(textAt(settlement, "InvoiceCurrencyCode"));
  const taxCurrency = textAt(settlement, "TaxCurrencyCode")?.trim().toUpperCase();

  const notes = childrenNamed(document, "IncludedNote")
    .map((note) => fields.text(textAt(note, "Content"), TEXT_CAPS.note))
    .filter((note): note is string => note !== undefined);
  if (notes.length > MAX_NOTES) {
    fields.add({
      code: "SD-NOTES",
      severity: "warning",
      message: `The invoice has more than ${MAX_NOTES} notes (BT-22); only the first ${MAX_NOTES} are shown.`,
    });
  }

  const lineItems = childrenNamed(transaction, "IncludedSupplyChainTradeLineItem");
  if (lineItems.length > MAX_LINES) {
    throw unreadable(`The e-invoice has more than ${MAX_LINES} lines`);
  }
  const lines = lineItems.map((item, index) => readLine(fields, item, index));

  const seller = readParty(fields, at(agreement, "SellerTradeParty"), "seller");
  const buyer = readParty(fields, at(agreement, "BuyerTradeParty"), "buyer");

  const means = childrenNamed(settlement, "SpecifiedTradeSettlementPaymentMeans");
  const firstMeans = means[0];
  const transferMeans =
    means.find((entry) => CREDIT_TRANSFER_MEANS.has(textAt(entry, "TypeCode") ?? "")) ?? firstMeans;
  const account = at(transferMeans, "PayeePartyCreditorFinancialAccount");
  const terms = childrenNamed(settlement, "SpecifiedTradePaymentTerms");
  const termsText = fields.joined(
    terms.map((term) => textAt(term, "Description")),
    TEXT_CAPS.description,
  );
  const dueDate = terms
    .map((term) => ciiDate(fields, at(term, "DueDateDateTime"), "The due date (BT-9)"))
    .find((date) => date !== undefined);

  const allowanceRows = childrenNamed(settlement, "SpecifiedTradeAllowanceCharge");
  const taxRows = childrenNamed(settlement, "ApplicableTradeTax");
  if (allowanceRows.length > MAX_ROWS || taxRows.length > MAX_ROWS) {
    throw unreadable(`The e-invoice has more than ${MAX_ROWS} allowances, charges or VAT rows`);
  }
  const allowancesCharges = allowanceRows.map((row, index) =>
    readAllowanceCharge(fields, row, index),
  );
  const vatBreakdown = taxRows.map((row, index) => {
    const category = requireVatCategory(
      textAt(row, "CategoryCode"),
      `VAT breakdown row ${index + 1} (BT-118)`,
    );
    return withoutUndefined({
      category,
      rate: fields.amount(textAt(row, "RateApplicablePercent"), "A VAT category rate (BT-119)"),
      taxableAmount:
        fields.amount(textAt(row, "BasisAmount"), "A VAT category taxable amount (BT-116)") ?? "0",
      taxAmount:
        fields.amount(textAt(row, "CalculatedAmount"), "A VAT category tax amount (BT-117)") ?? "0",
      exemptionReason: fields.text(textAt(row, "ExemptionReason"), TEXT_CAPS.reason),
      exemptionCode: fields.code(textAt(row, "ExemptionReasonCode")),
    });
  });

  const summation = at(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation");
  const taxTotals = childrenNamed(summation, "TaxTotalAmount");
  const taxInCurrency = (code: string): XmlElement | undefined =>
    taxTotals.find(
      (element) => (attribute(element, "currencyID") ?? currency).toUpperCase() === code,
    );
  const documentTax = taxInCurrency(currency) ?? taxTotals[0];
  const accountingTax =
    taxCurrency !== undefined && taxCurrency !== currency ? taxInCurrency(taxCurrency) : undefined;
  const raw: RawTotals = {
    lineNet: fields.amount(
      textAt(summation, "LineTotalAmount"),
      "The sum of line net amounts (BT-106)",
    ),
    allowances: fields.amount(
      textAt(summation, "AllowanceTotalAmount"),
      "The sum of allowances (BT-107)",
    ),
    charges: fields.amount(textAt(summation, "ChargeTotalAmount"), "The sum of charges (BT-108)"),
    net: fields.amount(textAt(summation, "TaxBasisTotalAmount"), "The total without VAT (BT-109)"),
    tax: fields.amount(documentTax?.text, "The total VAT amount (BT-110)"),
    taxInAccountingCurrency: fields.amount(
      accountingTax?.text,
      "The total VAT amount in accounting currency (BT-111)",
    ),
    gross: fields.amount(textAt(summation, "GrandTotalAmount"), "The total with VAT (BT-112)"),
    prepaid: fields.amount(textAt(summation, "TotalPrepaidAmount"), "The paid amount (BT-113)"),
    rounding: fields.amount(textAt(summation, "RoundingAmount"), "The rounding amount (BT-114)"),
    due: fields.amount(textAt(summation, "DuePayableAmount"), "The amount due (BT-115)"),
  };
  const { totals, missingTotals } = completeTotals(raw, {
    lineAmounts: lines.map((line) => line.netAmount),
    breakdownTax: vatBreakdown.map((row) => row.taxAmount),
  });

  const period = at(settlement, "BillingSpecifiedPeriod");
  const content: EInvoiceContent = withoutUndefined({
    syntax: "cii" as const,
    specificationId,
    profile: profileOf(specificationId),
    typeCode,
    documentKind: documentKindOf(typeCode),
    number,
    issueDate,
    dueDate,
    deliveryDate: ciiDate(
      fields,
      at(delivery, "ActualDeliverySupplyChainEvent", "OccurrenceDateTime"),
      "The actual delivery date (BT-72)",
    ),
    periodStart: ciiDate(fields, at(period, "StartDateTime"), "The invoicing period start (BT-73)"),
    periodEnd: ciiDate(fields, at(period, "EndDateTime"), "The invoicing period end (BT-74)"),
    currency,
    taxCurrency:
      taxCurrency !== undefined && taxCurrency !== currency && /^[A-Z]{3}$/.test(taxCurrency)
        ? taxCurrency
        : undefined,
    buyerReference: fields.text(textAt(agreement, "BuyerReference"), TEXT_CAPS.identifier),
    orderReference: fields.text(
      textAt(agreement, "BuyerOrderReferencedDocument", "IssuerAssignedID"),
      TEXT_CAPS.identifier,
    ),
    precedingInvoice: fields.text(
      textAt(settlement, "InvoiceReferencedDocument", "IssuerAssignedID"),
      TEXT_CAPS.identifier,
    ),
    seller: seller.party,
    buyer: buyer.party,
    payment: withoutUndefined({
      meansCode: fields.code(textAt(transferMeans, "TypeCode")),
      iban: normalizeIban(textAt(account, "IBANID") ?? textAt(account, "ProprietaryID")),
      bic: fields.code(
        textAt(transferMeans, "PayeeSpecifiedCreditorFinancialInstitution", "BICID"),
      ),
      accountName: fields.text(textAt(account, "AccountName"), TEXT_CAPS.name),
      remittance: fields.text(textAt(settlement, "PaymentReference"), TEXT_CAPS.reason),
      terms: termsText,
    }),
    notes: notes.slice(0, MAX_NOTES),
    lines,
    allowancesCharges,
    vatBreakdown,
    totals,
  });

  return {
    content,
    facts: {
      sellerLegalId: seller.legalId,
      buyerLegalId: buyer.legalId,
      missingTotals,
      paymentInstructions: means.some((entry) => textAt(entry, "TypeCode") !== undefined),
      taxCurrencyTotal: accountingTax !== undefined,
    },
    findings: fields.findings(),
  };
}

/** A CII date element (`…DateTime` containing `udt:DateTimeString format="102"`). */
function ciiDate(
  fields: FieldReader,
  element: XmlElement | undefined,
  term: string,
): string | undefined {
  const value = child(element, "DateTimeString");
  if (value === undefined) return undefined;
  return fields.date(value.text, term, attribute(value, "format") ?? "102");
}

function readParty(
  fields: FieldReader,
  element: XmlElement | undefined,
  role: "seller" | "buyer",
): { party: EInvoiceParty; legalId: boolean } {
  const countryTerm =
    role === "seller" ? "The seller country code (BT-40)" : "The buyer country code (BT-55)";
  const address = at(element, "PostalTradeAddress");
  const registrations = childrenNamed(element, "SpecifiedTaxRegistration");
  const registration = (scheme: string): string | undefined =>
    registrations
      .find((entry) => (attribute(child(entry, "ID"), "schemeID") ?? "") === scheme)
      ?.children.find((id) => id.name === "ID")?.text;
  const legal = at(element, "SpecifiedLegalOrganization");
  const identifier = textAt(element, "ID") ?? textAt(element, "GlobalID");
  return {
    party: partyOf({
      name: fields.text(textAt(element, "Name"), TEXT_CAPS.name),
      tradingName: fields.text(textAt(legal, "TradingBusinessName"), TEXT_CAPS.name),
      vatId: normalizeVatId(fields.text(registration("VA"), TEXT_CAPS.identifier)),
      taxNumber:
        role === "seller" ? fields.text(registration("FC"), TEXT_CAPS.identifier) : undefined,
      identifier: fields.text(identifier, TEXT_CAPS.identifier),
      electronicAddress: fields.text(
        textAt(element, "URIUniversalCommunication", "URIID"),
        TEXT_CAPS.address,
      ),
      email: fields.text(
        textAt(element, "DefinedTradeContact", "EmailURIUniversalCommunication", "URIID"),
        TEXT_CAPS.address,
      ),
      street: fields.joined(
        [textAt(address, "LineOne"), textAt(address, "LineTwo")],
        TEXT_CAPS.street,
      ),
      postcode: fields.text(textAt(address, "PostcodeCode"), TEXT_CAPS.postcode),
      city: fields.text(textAt(address, "CityName"), TEXT_CAPS.city),
      countryCode: fields.country(textAt(address, "CountryID"), countryTerm),
    }),
    legalId: textAt(legal, "ID") !== undefined,
  };
}

function readLine(fields: FieldReader, item: XmlElement, index: number): EInvoiceLine {
  const where = `Line ${index + 1}`;
  const lineDocument = at(item, "AssociatedDocumentLineDocument");
  const product = at(item, "SpecifiedTradeProduct");
  const agreement = at(item, "SpecifiedLineTradeAgreement");
  const settlement = at(item, "SpecifiedLineTradeSettlement");
  const tax = at(settlement, "ApplicableTradeTax");
  const quantityElement = at(item, "SpecifiedLineTradeDelivery", "BilledQuantity");
  const price = at(agreement, "NetPriceProductTradePrice");
  const netPrice = fields.amount(
    textAt(price, "ChargeAmount"),
    `The ${where.toLowerCase()} net price (BT-146)`,
  );
  const baseQuantity = fields.amount(
    textAt(price, "BasisQuantity"),
    `The ${where.toLowerCase()} price base quantity (BT-149)`,
  );
  const vatCategory = requireVatCategory(textAt(tax, "CategoryCode"), `${where} (BT-151)`);
  return withoutUndefined({
    id: fields.text(textAt(lineDocument, "LineID"), TEXT_CAPS.identifier) ?? String(index + 1),
    name: fields.text(textAt(product, "Name"), TEXT_CAPS.name) ?? "",
    description: fields.text(textAt(product, "Description"), TEXT_CAPS.description),
    quantity:
      fields.amount(quantityElement?.text, `The ${where.toLowerCase()} quantity (BT-129)`) ?? "0",
    unitCode: fields.code(attribute(quantityElement, "unitCode")),
    netPrice: pricePerUnit(netPrice, baseQuantity),
    netAmount:
      fields.amount(
        textAt(settlement, "SpecifiedTradeSettlementLineMonetarySummation", "LineTotalAmount"),
        `The ${where.toLowerCase()} net amount (BT-131)`,
      ) ?? "0",
    vatCategory,
    vatRate: fields.amount(
      textAt(tax, "RateApplicablePercent"),
      `The ${where.toLowerCase()} VAT rate (BT-152)`,
    ),
  });
}

function readAllowanceCharge(fields: FieldReader, row: XmlElement, index: number) {
  const indicator = textAt(row, "ChargeIndicator", "Indicator")?.toLowerCase();
  const kind = indicator === "true" ? ("charge" as const) : ("allowance" as const);
  const tax = at(row, "CategoryTradeTax");
  const term = kind === "charge" ? "BT-99" : "BT-92";
  return withoutUndefined({
    kind,
    amount:
      fields.amount(textAt(row, "ActualAmount"), `A document ${kind} amount (${term})`) ?? "0",
    vatCategory: requireVatCategory(
      textAt(tax, "CategoryCode"),
      `Document allowance/charge ${index + 1} (BT-95/BT-102)`,
    ),
    vatRate: fields.amount(
      textAt(tax, "RateApplicablePercent"),
      `A document ${kind} VAT rate (BT-96/BT-103)`,
    ),
    reason: fields.text(textAt(row, "Reason"), TEXT_CAPS.reason),
  });
}
