/**
 * The parsed e-invoice: the subset of the European e-invoicing standard EN 16931 that this server
 * reads from an XRechnung (UBL 2.1 or UN/CEFACT CII syntax) or a ZUGFeRD / Factur-X PDF (CII XML
 * attached to a PDF/A-3). Business term ids (BT-…, business groups BG-…) refer to EN 16931-1.
 *
 * Contract between the parser (`parse.ts`, m4-einvoice) and its consumers (the voucher import,
 * the e-invoice preflight, `sevdesk_einvoice_parse`). Rules every value follows:
 * - text fields come from a third party (the invoice issuer) and are already cleaned with
 *   `cleanText` (invisible/bidi characters removed, length capped); they are still untrusted:
 *   never put them into error messages or instructions;
 * - amounts are exact decimal strings (`"1190.00"`, `"-5.5"`), never floats, in `currency`
 *   unless stated otherwise; rates are percent as decimal strings (`"19"`, `"7.00"`);
 * - dates are `YYYY-MM-DD`;
 * - absent optional terms are omitted, never empty strings; `0` amounts are kept (B16).
 */
import { z } from "zod";

/** A decimal number as an exact string: optional minus, digits, optional fraction. */
const decimalStringSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/);
/** `YYYY-MM-DD`. */
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The XML syntax (EN 16931-3): UBL 2.1 (`Invoice`/`CreditNote` root) or CII (`CrossIndustryInvoice`). */
export const EINVOICE_SYNTAXES = ["ubl", "cii"] as const;

/** Where the XML came from: a standalone XML file, or an attachment inside a PDF (ZUGFeRD/Factur-X). */
export const EINVOICE_CONTAINERS = ["xml", "pdf"] as const;

/**
 * The profile, derived from the specification identifier (BT-24): XRechnung, the EN 16931 core
 * (ZUGFeRD/Factur-X "EN 16931" a.k.a. COMFORT), the ZUGFeRD/Factur-X profiles above and below it,
 * or `unknown`. MINIMUM and BASIC WL carry no lines and are not invoices under German law
 * (they are refused by the parser with a finding, but still described).
 */
export const EINVOICE_PROFILES = [
  "xrechnung",
  "en16931",
  "extended",
  "basic",
  "basic_wl",
  "minimum",
  "unknown",
] as const;
export type EInvoiceProfile = (typeof EINVOICE_PROFILES)[number];

/** BT-3 mapped to what the server does with it. */
export const EINVOICE_DOCUMENT_KINDS = ["invoice", "credit_note", "other"] as const;
export type EInvoiceDocumentKind = (typeof EINVOICE_DOCUMENT_KINDS)[number];

/**
 * VAT category codes (BT-95/BT-102/BT-118/BT-151, UNTDID 5305 subset of EN 16931):
 * S standard rate, Z zero rated, E exempt, AE reverse charge (§13b), K intra-community supply,
 * G export outside the EU, O not subject to VAT, L Canary Islands (IGIC), M Ceuta/Melilla (IPSI).
 */
export const VAT_CATEGORY_CODES = ["S", "Z", "E", "AE", "K", "G", "O", "L", "M"] as const;
export type VatCategoryCode = (typeof VAT_CATEGORY_CODES)[number];

const addressSchema = z.object({
  /** BT-35 / BT-50 (+ BT-36/BT-51 joined with a line break). */
  street: z.string().optional(),
  /** BT-38 / BT-53. */
  postcode: z.string().optional(),
  /** BT-37 / BT-52. */
  city: z.string().optional(),
  /** BT-40 / BT-55, ISO 3166-1 alpha-2 upper case. */
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
});

/** Seller (BG-4) or buyer (BG-7). */
export const einvoicePartySchema = z.object({
  /** BT-27 / BT-44. */
  name: z.string(),
  /** BT-28 / BT-45 trading name. */
  tradingName: z.string().optional(),
  /** BT-31 / BT-48: VAT identifier with country prefix, e.g. `DE123456789`. */
  vatId: z.string().optional(),
  /** BT-32 (seller only): tax registration number (Steuernummer). */
  taxNumber: z.string().optional(),
  /** BT-29 / BT-46 (first identifier only). */
  identifier: z.string().optional(),
  /** BT-34 / BT-49 electronic address (often an e-mail or a Leitweg-ID for public buyers). */
  electronicAddress: z.string().optional(),
  /** BT-43 / BT-58 contact e-mail. */
  email: z.string().optional(),
  address: addressSchema,
});
export type EInvoiceParty = z.output<typeof einvoicePartySchema>;

/** One invoice line (BG-25). */
const einvoiceLineSchema = z.object({
  /** BT-126. */
  id: z.string(),
  /** BT-153 item name. */
  name: z.string(),
  /** BT-154 item description. */
  description: z.string().optional(),
  /** BT-129 invoiced quantity (decimal). */
  quantity: decimalStringSchema,
  /** BT-130 unit code (UN/ECE Recommendation 20/21, e.g. `C62`, `HUR`, `XPP`). */
  unitCode: z.string().optional(),
  /** BT-146 item net price (per BT-149 base quantity, already divided out when present). */
  netPrice: decimalStringSchema.optional(),
  /** BT-131 line net amount. */
  netAmount: decimalStringSchema,
  /** BT-151. */
  vatCategory: z.enum(VAT_CATEGORY_CODES),
  /** BT-152; absent for category O. */
  vatRate: decimalStringSchema.optional(),
});
export type EInvoiceLine = z.output<typeof einvoiceLineSchema>;

/** Document-level allowance (BG-20) or charge (BG-21). */
const einvoiceAllowanceChargeSchema = z.object({
  kind: z.enum(["allowance", "charge"]),
  /** BT-92 / BT-99. */
  amount: decimalStringSchema,
  /** BT-95 / BT-102. */
  vatCategory: z.enum(VAT_CATEGORY_CODES),
  /** BT-96 / BT-103. */
  vatRate: decimalStringSchema.optional(),
  /** BT-97 / BT-104. */
  reason: z.string().optional(),
});

/** One VAT breakdown row (BG-23). */
const einvoiceVatBreakdownSchema = z.object({
  /** BT-118. */
  category: z.enum(VAT_CATEGORY_CODES),
  /** BT-119; absent for category O. */
  rate: decimalStringSchema.optional(),
  /** BT-116 taxable amount. */
  taxableAmount: decimalStringSchema,
  /** BT-117 VAT amount. */
  taxAmount: decimalStringSchema,
  /** BT-120 exemption reason text / BT-121 code. */
  exemptionReason: z.string().optional(),
  exemptionCode: z.string().optional(),
});

/** Document totals (BG-22). */
const einvoiceTotalsSchema = z.object({
  /** BT-106 sum of line net amounts. */
  lineNet: decimalStringSchema,
  /** BT-107. */
  allowances: decimalStringSchema.optional(),
  /** BT-108. */
  charges: decimalStringSchema.optional(),
  /** BT-109 total without VAT. */
  net: decimalStringSchema,
  /** BT-110 total VAT in the document currency. */
  tax: decimalStringSchema,
  /** BT-111 total VAT in the VAT accounting currency (BT-6), when it differs. */
  taxInAccountingCurrency: decimalStringSchema.optional(),
  /** BT-112 total with VAT. */
  gross: decimalStringSchema,
  /** BT-113 paid amount. */
  prepaid: decimalStringSchema.optional(),
  /** BT-114 rounding amount. */
  rounding: decimalStringSchema.optional(),
  /** BT-115 amount due for payment. */
  due: decimalStringSchema,
});

/** A problem the parser or the checks found. `message` is trusted text written by us. */
export const einvoiceFindingSchema = z.object({
  /** EN 16931 rule id (`BR-CO-10`, `BR-S-08`, …), an XRechnung rule (`BR-DE-15`) or ours (`SD-…`). */
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
});
export type EInvoiceFinding = z.output<typeof einvoiceFindingSchema>;

export const parsedEInvoiceSchema = z.object({
  syntax: z.enum(EINVOICE_SYNTAXES),
  container: z.enum(EINVOICE_CONTAINERS),
  /** PDF container only: the attachment's file name, e.g. `factur-x.xml`, `xrechnung.xml`. */
  attachmentName: z.string().optional(),
  /** BT-24 specification identifier, as written. */
  specificationId: z.string().optional(),
  profile: z.enum(EINVOICE_PROFILES),
  /** BT-3 invoice type code (UNTDID 1001), e.g. `380` invoice, `381` credit note, `384` corrected. */
  typeCode: z.string(),
  documentKind: z.enum(EINVOICE_DOCUMENT_KINDS),
  /** BT-1 invoice number. */
  number: z.string(),
  /** BT-2. */
  issueDate: isoDateSchema,
  /** BT-9. */
  dueDate: isoDateSchema.optional(),
  /** BT-72 actual delivery date. */
  deliveryDate: isoDateSchema.optional(),
  /** BG-14 invoicing period (BT-73/BT-74). */
  periodStart: isoDateSchema.optional(),
  periodEnd: isoDateSchema.optional(),
  /** BT-5 ISO 4217, upper case. */
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** BT-6 VAT accounting currency when it differs from BT-5. */
  taxCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  /** BT-10 buyer reference (Leitweg-ID for German public buyers). */
  buyerReference: z.string().optional(),
  /** BT-13 purchase order reference. */
  orderReference: z.string().optional(),
  /** BT-25 preceding invoice number (credit notes, corrections). */
  precedingInvoice: z.string().optional(),
  seller: einvoicePartySchema,
  buyer: einvoicePartySchema,
  payment: z.object({
    /** BT-81 payment means code (UNTDID 4461), e.g. `58` SEPA credit transfer. */
    meansCode: z.string().optional(),
    /** BT-84 payee IBAN (first account only), spaces removed. */
    iban: z.string().optional(),
    /** BT-86 BIC. */
    bic: z.string().optional(),
    /** BT-85 account name. */
    accountName: z.string().optional(),
    /** BT-83 remittance information (Verwendungszweck). */
    remittance: z.string().optional(),
    /** BT-20 payment terms text. */
    terms: z.string().optional(),
    /**
     * BG-10: present when the invoice names a payee of its own (CII `PayeeTradeParty`, UBL
     * `PayeeParty`), e.g. a factoring company. The payment account (BT-84) is then the payee's,
     * so it says nothing about who the seller is. `name` is BT-59 (untrusted, cleaned).
     */
    payee: z.object({ name: z.string().optional() }).optional(),
  }),
  /** BT-22 notes (capped). */
  notes: z.array(z.string()),
  lines: z.array(einvoiceLineSchema),
  allowancesCharges: z.array(einvoiceAllowanceChargeSchema),
  vatBreakdown: z.array(einvoiceVatBreakdownSchema),
  totals: einvoiceTotalsSchema,
  /** Rule violations and parser notes, errors first. Empty when everything checked out. */
  findings: z.array(einvoiceFindingSchema),
});
export type ParsedEInvoice = z.output<typeof parsedEInvoiceSchema>;

/** Largest XML document the parser accepts (after extraction from a PDF), in bytes. */
export const MAX_EINVOICE_XML_BYTES = 5 * 1024 * 1024;
/** Largest e-invoice file (XML or PDF) read from disk, in bytes. */
export const MAX_EINVOICE_FILE_BYTES = 20 * 1024 * 1024;
