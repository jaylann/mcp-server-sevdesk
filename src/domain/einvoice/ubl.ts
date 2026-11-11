/**
 * Reads an OASIS UBL 2.1 `Invoice` or `CreditNote` (as profiled by EN 16931-3-2) into the
 * e-invoice model: the syntax of XRechnung UBL and Peppol BIS Billing 3.0. Root namespaces:
 * `urn:oasis:names:specification:ubl:schema:xsd:Invoice-2` and `…:CreditNote-2`.
 *
 * Paths follow the EN 16931-3-2 syntax binding. The differences between the two roots are the
 * type code element (`InvoiceTypeCode` / `CreditNoteTypeCode`), the line element and its quantity
 * (`InvoiceLine/InvoicedQuantity` / `CreditNoteLine/CreditedQuantity`) and the due date (BT-9:
 * `cbc:DueDate` on an invoice, `cac:PaymentMeans/cbc:PaymentDueDate` on a credit note).
 *
 * Elements are matched by namespace and local name, whatever prefix the file uses: the reader
 * works on the tree without the elements that are not in the namespace UBL defines for their
 * name ({@link isUblElement}).
 */
import { CREDIT_TRANSFER_MEANS, documentKindOf, profileOf } from "./codes.js";
import { pricePerUnit } from "./decimal.js";
import {
  completeTotals,
  type EInvoiceContent,
  type ExtractedEInvoice,
  type LineAdjustment,
  type LinePricing,
  linePricing,
  type RawTotals,
} from "./extracted.js";
import {
  FieldReader,
  MAX_LINES,
  MAX_NOTES,
  MAX_ROWS,
  normalizeDecimal,
  normalizeIban,
  normalizeVatId,
  partyOf,
  requireCurrency,
  requireVatCategory,
  TEXT_CAPS,
  unreadable,
  withoutUndefined,
} from "./fields.js";
import type { EInvoiceDocumentKind, EInvoiceLine, EInvoiceParty } from "./model.js";
import { at, attribute, childrenNamed, elementsOf, textAt, type XmlElement } from "./xml.js";

/** Namespace URIs of the two UBL roots EN 16931 uses. */
export const UBL_NAMESPACES = {
  Invoice: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  CreditNote: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
} as const;

export type UblRoot = keyof typeof UBL_NAMESPACES;

/** Namespace of the aggregates (elements that hold other elements), usual prefix `cac`. */
const UBL_AGGREGATE_NAMESPACE =
  "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2";
/** Namespace of the basic components (elements that hold a value), usual prefix `cbc`. */
const UBL_BASIC_NAMESPACE = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";

/**
 * The aggregates this reader walks through (`cac:…` in UBL 2.1). Every other element it reads
 * holds a value and is a basic component (`cbc:…`). An aggregate that is missing here is not
 * found by the reader at all, so a path added to the reader needs its aggregates added here.
 */
const UBL_AGGREGATES: ReadonlySet<string> = new Set([
  "AccountingCustomerParty",
  "AccountingSupplierParty",
  "AllowanceCharge",
  "BillingReference",
  "ClassifiedTaxCategory",
  "Contact",
  "Country",
  "CreditNoteLine",
  "Delivery",
  "FinancialInstitutionBranch",
  "InvoiceDocumentReference",
  "InvoiceLine",
  "InvoicePeriod",
  "Item",
  "LegalMonetaryTotal",
  "OrderReference",
  "Party",
  "PartyIdentification",
  "PartyLegalEntity",
  "PartyName",
  "PartyTaxScheme",
  "PayeeFinancialAccount",
  "PayeeParty",
  "PaymentMeans",
  "PaymentTerms",
  "PostalAddress",
  "Price",
  "TaxCategory",
  "TaxScheme",
  "TaxSubtotal",
  "TaxTotal",
]);

/**
 * Whether an element is the UBL element of that name: an aggregate in the aggregate namespace, a
 * value in the basic namespace. Review 2026-11, round 3: lookups went by local name alone, so an
 * element of another namespace could stand in for a field.
 */
function isUblElement(name: string, namespace: string | undefined): boolean {
  return namespace === (UBL_AGGREGATES.has(name) ? UBL_AGGREGATE_NAMESPACE : UBL_BASIC_NAMESPACE);
}

/**
 * The document kind of a UBL document. The root element decides: `Invoice` carries
 * `InvoiceTypeCode` from the invoice subset of UNTDID 1001, `CreditNote` carries
 * `CreditNoteTypeCode` from the credit note subset. EN 16931-3-2 binds BT-3 to the two elements
 * that way, and rule BR-CL-01 of the CEN validation artefacts for UBL checks each element
 * against its own subset (the subsets are in `codes.ts`). A code of the other subset contradicts
 * the root; such a file is refused, because either reading of it would be a guess: a `CreditNote`
 * with code 380 used to count as an invoice and would have been imported as a positive expense
 * (review 2026-11, round 3). A code of neither subset stays `other`, which is reported and not
 * imported.
 */
function ublDocumentKind(root: UblRoot, typeCode: string): EInvoiceDocumentKind {
  const kind = documentKindOf(typeCode);
  if (root === "CreditNote" && kind === "invoice") {
    throw unreadable(
      "The e-invoice is a UBL credit note (root element CreditNote) but carries an invoice type " +
        "code (BT-3). The two contradict each other; ask the sender for a corrected file",
    );
  }
  if (root === "Invoice" && kind === "credit_note") {
    throw unreadable(
      "The e-invoice is a UBL invoice (root element Invoice) but carries a credit note type " +
        "code (BT-3). The two contradict each other; ask the sender for a corrected file",
    );
  }
  return kind;
}

/** Reads an `Invoice` or `CreditNote` root element. */
export function readUbl(rootElement: XmlElement, kind: UblRoot): ExtractedEInvoice {
  const root = elementsOf(rootElement, isUblElement);
  const fields = new FieldReader();
  const isCreditNote = kind === "CreditNote";

  const specificationId = fields.text(textAt(root, "CustomizationID"), TEXT_CAPS.specification);
  const number = fields.text(textAt(root, "ID"), TEXT_CAPS.identifier);
  if (number === undefined) throw unreadable("The e-invoice has no invoice number (BT-1, BR-02)");
  const typeCode = fields.code(
    textAt(root, isCreditNote ? "CreditNoteTypeCode" : "InvoiceTypeCode"),
  );
  if (typeCode === undefined) {
    throw unreadable("The e-invoice has no valid invoice type code (BT-3, BR-04)");
  }
  const documentKind = ublDocumentKind(kind, typeCode);
  const issueDate = fields.date(textAt(root, "IssueDate"), "The issue date (BT-2)");
  if (issueDate === undefined) {
    throw unreadable("The e-invoice has no readable issue date (BT-2, BR-03)");
  }
  const currency = requireCurrency(textAt(root, "DocumentCurrencyCode"));
  const taxCurrency = textAt(root, "TaxCurrencyCode")?.trim().toUpperCase();

  const noteElements = childrenNamed(root, "Note");
  const notes = noteElements
    .map((note) => fields.text(note.text, TEXT_CAPS.note))
    .filter((note): note is string => note !== undefined);
  if (notes.length > MAX_NOTES) {
    fields.add({
      code: "SD-NOTES",
      severity: "warning",
      message: `The invoice has more than ${MAX_NOTES} notes (BT-22); only the first ${MAX_NOTES} are shown.`,
    });
  }

  const lineElements = childrenNamed(root, isCreditNote ? "CreditNoteLine" : "InvoiceLine");
  if (lineElements.length > MAX_LINES) {
    throw unreadable(`The e-invoice has more than ${MAX_LINES} lines`);
  }
  const readLines = lineElements.map((line, index) =>
    readLine(fields, line, index, isCreditNote ? "CreditedQuantity" : "InvoicedQuantity"),
  );
  const lines = readLines.map((entry) => entry.line);

  const seller = readParty(fields, at(root, "AccountingSupplierParty", "Party"), "seller");
  const buyer = readParty(fields, at(root, "AccountingCustomerParty", "Party"), "buyer");
  // BG-10: a payee that is not the seller (factoring); its account is the one in BG-17.
  const payee = at(root, "PayeeParty");

  const means = childrenNamed(root, "PaymentMeans");
  const transferMeans =
    means.find((entry) => CREDIT_TRANSFER_MEANS.has(textAt(entry, "PaymentMeansCode") ?? "")) ??
    means[0];
  const account = at(transferMeans, "PayeeFinancialAccount");
  const dueDateText = isCreditNote
    ? means.map((entry) => textAt(entry, "PaymentDueDate")).find((date) => date !== undefined)
    : textAt(root, "DueDate");

  const allowanceRows = childrenNamed(root, "AllowanceCharge");
  const taxTotals = childrenNamed(root, "TaxTotal");
  const subtotals = taxTotals.flatMap((total) => childrenNamed(total, "TaxSubtotal"));
  if (allowanceRows.length > MAX_ROWS || subtotals.length > MAX_ROWS) {
    throw unreadable(`The e-invoice has more than ${MAX_ROWS} allowances, charges or VAT rows`);
  }
  const allowancesCharges = allowanceRows.map((row, index) =>
    readAllowanceCharge(fields, row, index),
  );

  const taxAmountIn = (code: string): XmlElement | undefined =>
    taxTotals
      .map((total) => at(total, "TaxAmount"))
      .find(
        (amount) =>
          amount !== undefined &&
          (attribute(amount, "currencyID") ?? currency).toUpperCase() === code,
      );
  const documentTaxTotal =
    taxTotals.find((total) => {
      const amount = at(total, "TaxAmount");
      return (attribute(amount, "currencyID") ?? currency).toUpperCase() === currency;
    }) ?? taxTotals[0];
  const breakdownRows = childrenNamed(documentTaxTotal, "TaxSubtotal");
  const vatBreakdown = breakdownRows.map((row, index) => {
    const category = at(row, "TaxCategory");
    return withoutUndefined({
      category: requireVatCategory(
        textAt(category, "ID"),
        `VAT breakdown row ${index + 1} (BT-118)`,
      ),
      rate: fields.amount(textAt(category, "Percent"), "A VAT category rate (BT-119)"),
      taxableAmount:
        fields.amount(textAt(row, "TaxableAmount"), "A VAT category taxable amount (BT-116)") ??
        "0",
      taxAmount:
        fields.amount(textAt(row, "TaxAmount"), "A VAT category tax amount (BT-117)") ?? "0",
      exemptionReason: fields.text(textAt(category, "TaxExemptionReason"), TEXT_CAPS.reason),
      exemptionCode: fields.code(textAt(category, "TaxExemptionReasonCode")),
    });
  });

  const monetary = at(root, "LegalMonetaryTotal");
  const accountingTax =
    taxCurrency !== undefined && taxCurrency !== currency ? taxAmountIn(taxCurrency) : undefined;
  const raw: RawTotals = {
    lineNet: fields.amount(
      textAt(monetary, "LineExtensionAmount"),
      "The sum of line net amounts (BT-106)",
    ),
    allowances: fields.amount(
      textAt(monetary, "AllowanceTotalAmount"),
      "The sum of allowances (BT-107)",
    ),
    charges: fields.amount(textAt(monetary, "ChargeTotalAmount"), "The sum of charges (BT-108)"),
    net: fields.amount(textAt(monetary, "TaxExclusiveAmount"), "The total without VAT (BT-109)"),
    tax: fields.amount(taxAmountIn(currency)?.text, "The total VAT amount (BT-110)"),
    taxInAccountingCurrency: fields.amount(
      accountingTax?.text,
      "The total VAT amount in accounting currency (BT-111)",
    ),
    gross: fields.amount(textAt(monetary, "TaxInclusiveAmount"), "The total with VAT (BT-112)"),
    prepaid: fields.amount(textAt(monetary, "PrepaidAmount"), "The paid amount (BT-113)"),
    rounding: fields.amount(
      textAt(monetary, "PayableRoundingAmount"),
      "The rounding amount (BT-114)",
    ),
    due: fields.amount(textAt(monetary, "PayableAmount"), "The amount due (BT-115)"),
  };
  const { totals, missingTotals } = completeTotals(raw, {
    lineAmounts: lines.map((line) => line.netAmount),
    breakdownTax: vatBreakdown.map((row) => row.taxAmount),
  });

  const period = at(root, "InvoicePeriod");
  const terms = childrenNamed(root, "PaymentTerms").map((term) => textAt(term, "Note"));
  const content: EInvoiceContent = withoutUndefined({
    syntax: "ubl" as const,
    specificationId,
    profile: profileOf(specificationId),
    typeCode,
    documentKind,
    number,
    issueDate,
    dueDate: fields.date(dueDateText, "The due date (BT-9)"),
    deliveryDate: fields.date(
      textAt(root, "Delivery", "ActualDeliveryDate"),
      "The actual delivery date (BT-72)",
    ),
    periodStart: fields.date(textAt(period, "StartDate"), "The invoicing period start (BT-73)"),
    periodEnd: fields.date(textAt(period, "EndDate"), "The invoicing period end (BT-74)"),
    currency,
    taxCurrency:
      taxCurrency !== undefined && taxCurrency !== currency && /^[A-Z]{3}$/.test(taxCurrency)
        ? taxCurrency
        : undefined,
    buyerReference: fields.text(textAt(root, "BuyerReference"), TEXT_CAPS.identifier),
    orderReference: fields.text(textAt(root, "OrderReference", "ID"), TEXT_CAPS.identifier),
    precedingInvoice: fields.text(
      textAt(root, "BillingReference", "InvoiceDocumentReference", "ID"),
      TEXT_CAPS.identifier,
    ),
    seller: seller.party,
    buyer: buyer.party,
    payment: withoutUndefined({
      meansCode: fields.code(textAt(transferMeans, "PaymentMeansCode")),
      iban: normalizeIban(textAt(account, "ID")),
      bic: fields.code(textAt(account, "FinancialInstitutionBranch", "ID")),
      accountName: fields.text(textAt(account, "Name"), TEXT_CAPS.name),
      remittance: fields.text(textAt(transferMeans, "PaymentID"), TEXT_CAPS.reason),
      terms: fields.joined(terms, TEXT_CAPS.description),
      payee:
        payee === undefined
          ? undefined
          : withoutUndefined({
              name: fields.text(textAt(payee, "PartyName", "Name"), TEXT_CAPS.name),
            }),
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
      paymentInstructions: means.some((entry) => textAt(entry, "PaymentMeansCode") !== undefined),
      taxCurrencyTotal: accountingTax !== undefined,
      linePricing: readLines.map((entry) => entry.pricing),
    },
    findings: fields.findings(),
  };
}

function readParty(
  fields: FieldReader,
  element: XmlElement | undefined,
  role: "seller" | "buyer",
): { party: EInvoiceParty; legalId: boolean } {
  const countryTerm =
    role === "seller" ? "The seller country code (BT-40)" : "The buyer country code (BT-55)";
  const address = at(element, "PostalAddress");
  const schemes = childrenNamed(element, "PartyTaxScheme");
  const vatScheme = schemes.find(
    (scheme) => textAt(scheme, "TaxScheme", "ID")?.toUpperCase() === "VAT",
  );
  const otherScheme = schemes.find((scheme) => scheme !== vatScheme);
  const legal = at(element, "PartyLegalEntity");
  return {
    party: partyOf({
      name: fields.text(textAt(legal, "RegistrationName"), TEXT_CAPS.name),
      tradingName: fields.text(textAt(element, "PartyName", "Name"), TEXT_CAPS.name),
      vatId: normalizeVatId(fields.text(textAt(vatScheme, "CompanyID"), TEXT_CAPS.identifier)),
      taxNumber:
        role === "seller"
          ? fields.text(textAt(otherScheme, "CompanyID"), TEXT_CAPS.identifier)
          : undefined,
      identifier: fields.text(textAt(element, "PartyIdentification", "ID"), TEXT_CAPS.identifier),
      electronicAddress: fields.text(textAt(element, "EndpointID"), TEXT_CAPS.address),
      email: fields.text(textAt(element, "Contact", "ElectronicMail"), TEXT_CAPS.address),
      street: fields.joined(
        [textAt(address, "StreetName"), textAt(address, "AdditionalStreetName")],
        TEXT_CAPS.street,
      ),
      postcode: fields.text(textAt(address, "PostalZone"), TEXT_CAPS.postcode),
      city: fields.text(textAt(address, "CityName"), TEXT_CAPS.city),
      countryCode: fields.country(textAt(address, "Country", "IdentificationCode"), countryTerm),
    }),
    legalId: textAt(legal, "CompanyID") !== undefined,
  };
}

function readLine(
  fields: FieldReader,
  line: XmlElement,
  index: number,
  quantityName: "InvoicedQuantity" | "CreditedQuantity",
): { line: EInvoiceLine; pricing: LinePricing | undefined } {
  const where = `line ${index + 1}`;
  const item = at(line, "Item");
  const category = at(item, "ClassifiedTaxCategory");
  const quantityElement = at(line, quantityName);
  const price = at(line, "Price");
  const quantity = fields.amount(quantityElement?.text, `The ${where} quantity (BT-129)`);
  const netPrice = fields.amount(textAt(price, "PriceAmount"), `The ${where} net price (BT-146)`);
  const baseQuantity = fields.amount(
    textAt(price, "BaseQuantity"),
    `The ${where} price base quantity (BT-149)`,
  );
  // Line allowances (BG-27) and charges (BG-28), the direct children of the line (the one inside
  // `cac:Price` is the price discount, BT-147): only their sum is needed, for the line check.
  // Read without a finding: a part that cannot be read only switches that line's check off.
  const adjustments = childrenNamed(line, "AllowanceCharge").map((row): LineAdjustment => {
    const indicator = textAt(row, "ChargeIndicator")?.toLowerCase();
    const kind = indicator === "true" ? "charge" : indicator === "false" ? "allowance" : undefined;
    return { kind, amount: normalizeDecimal(textAt(row, "Amount") ?? "") };
  });
  const read: EInvoiceLine = withoutUndefined({
    id: fields.text(textAt(line, "ID"), TEXT_CAPS.identifier) ?? String(index + 1),
    name: fields.text(textAt(item, "Name"), TEXT_CAPS.name) ?? "",
    description: fields.text(textAt(item, "Description"), TEXT_CAPS.description),
    quantity: quantity ?? "0",
    unitCode: fields.code(attribute(quantityElement, "unitCode")),
    netPrice: pricePerUnit(netPrice, baseQuantity),
    netAmount:
      fields.amount(textAt(line, "LineExtensionAmount"), `The ${where} net amount (BT-131)`) ?? "0",
    vatCategory: requireVatCategory(textAt(category, "ID"), `Line ${index + 1} (BT-151)`),
    vatRate: fields.amount(textAt(category, "Percent"), `The ${where} VAT rate (BT-152)`),
  });
  return {
    line: read,
    pricing: linePricing({ quantity, price: netPrice, baseQuantity, adjustments }),
  };
}

function readAllowanceCharge(fields: FieldReader, row: XmlElement, index: number) {
  const kind =
    textAt(row, "ChargeIndicator")?.toLowerCase() === "true"
      ? ("charge" as const)
      : ("allowance" as const);
  const category = at(row, "TaxCategory");
  const term = kind === "charge" ? "BT-99" : "BT-92";
  return withoutUndefined({
    kind,
    amount: fields.amount(textAt(row, "Amount"), `A document ${kind} amount (${term})`) ?? "0",
    vatCategory: requireVatCategory(
      textAt(category, "ID"),
      `Document allowance/charge ${index + 1} (BT-95/BT-102)`,
    ),
    vatRate: fields.amount(
      textAt(category, "Percent"),
      `A document ${kind} VAT rate (BT-96/BT-103)`,
    ),
    reason: fields.text(textAt(row, "AllowanceChargeReason"), TEXT_CAPS.reason),
  });
}
