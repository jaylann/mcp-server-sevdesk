import { z } from "zod";

import { maskIban } from "../../domain/banking.js";
import { cleanText, moneySchema } from "../../domain/common.js";
import { PROFILE_LABELS, typeCodeLabel, unitLabel } from "../../domain/einvoice/codes.js";
import {
  EINVOICE_CONTAINERS,
  EINVOICE_DOCUMENT_KINDS,
  EINVOICE_PROFILES,
  EINVOICE_SYNTAXES,
  einvoiceFindingSchema,
  einvoicePartySchema,
  MAX_EINVOICE_FILE_BYTES,
  type ParsedEInvoice,
  VAT_CATEGORY_CODES,
} from "../../domain/einvoice/model.js";
import { parseEInvoice } from "../../domain/einvoice/parse.js";
import {
  einvoiceVoucherSuggestionSchema,
  planVoucherFromEInvoice,
} from "../../domain/einvoice/voucher-suggestion.js";
import { money } from "../../domain/money.js";
import { canReadFiles } from "../../safety/file-access.js";
import { defineTool } from "../define-tool.js";

/** Lines shown in the output; the rest is counted (`linesTotal`). */
const MAX_LINES_SHOWN = 50;
const FILE_NAME_MAX = 100;

const lineSchema = z.object({
  id: z.string().describe("Line id (BT-126)."),
  name: z.string().describe("Item name (BT-153)."),
  description: z.string().optional(),
  quantity: z.string().describe("Exact decimal (BT-129)."),
  unitCode: z.string().optional().describe("UN/ECE unit code (BT-130), e.g. C62, HUR."),
  unit: z.string().optional().describe("Readable unit for common codes."),
  netPrice: z.string().optional().describe("Net price per unit (BT-146), exact decimal."),
  netAmount: moneySchema.describe("Line net amount (BT-131)."),
  vatCategory: z.enum(VAT_CATEGORY_CODES),
  vatRate: z.string().optional().describe("Percent (BT-152)."),
});

const output = z.object({
  file: z.object({
    name: z.string().describe("Base name of the file that was read."),
    kind: z.enum(["xml", "pdf"]),
  }),
  invoice: z.object({
    syntax: z.enum(EINVOICE_SYNTAXES).describe("ubl (UBL 2.1) or cii (UN/CEFACT CII)."),
    container: z.enum(EINVOICE_CONTAINERS),
    attachmentName: z.string().optional().describe("PDF only: the embedded XML's file name."),
    profile: z.enum(EINVOICE_PROFILES),
    profileLabel: z.string(),
    specificationId: z.string().optional().describe("BT-24."),
    typeCode: z.string().describe("BT-3, e.g. 380 invoice, 381 credit note, 384 corrected."),
    typeLabel: z.string(),
    documentKind: z.enum(EINVOICE_DOCUMENT_KINDS),
    number: z.string().describe("Rechnungsnummer (BT-1)."),
    issueDate: z.string().describe("Rechnungsdatum (BT-2), YYYY-MM-DD."),
    dueDate: z.string().optional().describe("Fälligkeitsdatum (BT-9)."),
    deliveryDate: z.string().optional().describe("Leistungsdatum (BT-72)."),
    periodStart: z.string().optional(),
    periodEnd: z.string().optional(),
    currency: z.string(),
    taxCurrency: z.string().optional(),
    buyerReference: z.string().optional().describe("BT-10, Leitweg-ID for public buyers."),
    orderReference: z.string().optional(),
    precedingInvoice: z.string().optional().describe("BT-25, e.g. the corrected invoice."),
    seller: einvoicePartySchema.describe("Verkäufer / Lieferant (BG-4)."),
    buyer: einvoicePartySchema.describe("Käufer (BG-7)."),
    payment: z.object({
      meansCode: z.string().optional().describe("BT-81, e.g. 58 SEPA credit transfer."),
      ibanMasked: z.string().optional().describe("Payee IBAN (BT-84), masked."),
      bic: z.string().optional(),
      accountName: z.string().optional(),
      remittance: z.string().optional().describe("Verwendungszweck (BT-83)."),
      terms: z.string().optional().describe("Zahlungsbedingungen (BT-20)."),
    }),
    notes: z.array(z.string()).describe("Invoice notes (BT-22), text from the issuer."),
    lines: z.array(lineSchema).describe(`Invoice lines, at most ${MAX_LINES_SHOWN}.`),
    linesTotal: z.number().int().describe("Number of lines in the invoice."),
    allowancesCharges: z.array(
      z.object({
        kind: z.enum(["allowance", "charge"]).describe("Nachlass or Zuschlag (document level)."),
        amount: moneySchema,
        vatCategory: z.enum(VAT_CATEGORY_CODES),
        vatRate: z.string().optional(),
        reason: z.string().optional(),
      }),
    ),
    vatBreakdown: z
      .array(
        z.object({
          category: z.enum(VAT_CATEGORY_CODES),
          rate: z.string().optional(),
          taxableAmount: moneySchema,
          taxAmount: moneySchema,
          exemptionReason: z.string().optional(),
          exemptionCode: z.string().optional(),
        }),
      )
      .describe("Umsatzsteuer per category and rate (BG-23)."),
    totals: z.object({
      lineNet: moneySchema.describe("BT-106."),
      allowances: moneySchema.optional().describe("BT-107."),
      charges: moneySchema.optional().describe("BT-108."),
      net: moneySchema.describe("Netto (BT-109)."),
      tax: moneySchema.describe("Umsatzsteuer (BT-110)."),
      taxInAccountingCurrency: moneySchema.optional().describe("BT-111, in taxCurrency."),
      gross: moneySchema.describe("Brutto (BT-112)."),
      prepaid: moneySchema.optional().describe("Already paid (BT-113)."),
      rounding: moneySchema.optional().describe("BT-114."),
      due: moneySchema.describe("Amount due (BT-115)."),
    }),
  }),
  findings: z
    .array(einvoiceFindingSchema)
    .describe("EN 16931 / XRechnung rule violations and parser notes, errors first."),
  suggestedVoucher: einvoiceVoucherSuggestionSchema.describe(
    "Voucher (Beleg) fields for sevdesk_voucher_import_einvoice.",
  ),
  readyToImport: z
    .boolean()
    .describe("True when suggestedVoucher.blocking is empty: the import can run as suggested."),
});

type Output = z.output<typeof output>;

/** `sevdesk_einvoice_parse`: read an XRechnung / ZUGFeRD file (local or uploaded). */
export const einvoiceParseTool = defineTool({
  name: "sevdesk_einvoice_parse",
  title: "Parse an e-invoice file",
  description:
    "Read an e-invoice (E-Rechnung) from a folder listed in SEVDESK_FILE_DIRS or, on a remote " +
    "server, from an upload (sevdesk_upload_request purpose einvoice): an " +
    "XRechnung (UBL or CII XML) or a ZUGFeRD / Factur-X PDF with embedded XML. Returns the " +
    "EN 16931 data (Lieferant/seller, buyer, Rechnungsnummer, dates, lines, VAT breakdown, " +
    "totals), rule findings (sums, VAT categories, XRechnung rules) and a suggested voucher " +
    "(Beleg): Ausgabe or Einnahme, matching sevDesk contacts (by USt-IdNr., IBAN, exact name), " +
    "tax rule (Steuerregel), one position per VAT rate, Belegnummer and dates. Read only: " +
    "nothing is sent to sevDesk and no contact is created. A plain PDF receipt without XML is " +
    "refused: book it with sevdesk_voucher_create_draft and the file. Next: " +
    "sevdesk_voucher_import_einvoice creates the draft voucher with the file attached.",
  toolset: "vouchers",
  tier: "read",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  localEffects: "reads-files",
  available: canReadFiles,
  input: z.strictObject({
    file: z
      .string()
      .min(1)
      .max(1_024)
      .describe(
        "The e-invoice file: an absolute path inside one of the SEVDESK_FILE_DIRS folders, or " +
          "a path relative to one of them, e.g. Rechnungen/RE-4711.xml; or on a remote server " +
          "the uploadId from sevdesk_upload_request.",
      ),
  }),
  output,
  handler: async (args, ctx) => {
    const file = await ctx.files.read(args.file, {
      maxBytes: MAX_EINVOICE_FILE_BYTES,
      kinds: ["xml", "pdf"],
    });
    const parsed = await parseEInvoice(file.bytes);
    const suggestion = await planVoucherFromEInvoice(parsed, {
      client: ctx.client,
      cacheOwner: ctx.config,
      signal: ctx.signal,
    });
    const kind: "xml" | "pdf" = file.kind === "pdf" ? "pdf" : "xml";
    const data: Output = {
      file: { name: cleanText(file.name, FILE_NAME_MAX) ?? "file", kind },
      invoice: invoiceDto(parsed),
      findings: parsed.findings,
      suggestedVoucher: suggestion,
      readyToImport: suggestion.blocking.length === 0,
    };
    return { data, summary: summaryOf(parsed, suggestion) };
  },
});

function invoiceDto(parsed: ParsedEInvoice): Output["invoice"] {
  const { currency } = parsed;
  const amount = (value: string): { amount: string; currency: string } => money(value, currency);
  const optionalAmount = (
    value: string | undefined,
    code = currency,
  ): { amount: string; currency: string } | undefined =>
    value === undefined ? undefined : money(value, code);
  const { totals } = parsed;
  return withoutUndefined({
    syntax: parsed.syntax,
    container: parsed.container,
    attachmentName: parsed.attachmentName,
    profile: parsed.profile,
    profileLabel: PROFILE_LABELS[parsed.profile],
    specificationId: parsed.specificationId,
    typeCode: parsed.typeCode,
    typeLabel: typeCodeLabel(parsed.typeCode),
    documentKind: parsed.documentKind,
    number: parsed.number,
    issueDate: parsed.issueDate,
    dueDate: parsed.dueDate,
    deliveryDate: parsed.deliveryDate,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    currency,
    taxCurrency: parsed.taxCurrency,
    buyerReference: parsed.buyerReference,
    orderReference: parsed.orderReference,
    precedingInvoice: parsed.precedingInvoice,
    seller: parsed.seller,
    buyer: parsed.buyer,
    payment: withoutUndefined({
      meansCode: parsed.payment.meansCode,
      ibanMasked: maskIban(parsed.payment.iban),
      bic: parsed.payment.bic,
      accountName: parsed.payment.accountName,
      remittance: parsed.payment.remittance,
      terms: parsed.payment.terms,
    }),
    notes: parsed.notes,
    lines: parsed.lines.slice(0, MAX_LINES_SHOWN).map((line) =>
      withoutUndefined({
        id: line.id,
        name: line.name,
        description: line.description,
        quantity: line.quantity,
        unitCode: line.unitCode,
        unit: unitLabel(line.unitCode),
        netPrice: line.netPrice,
        netAmount: amount(line.netAmount),
        vatCategory: line.vatCategory,
        vatRate: line.vatRate,
      }),
    ),
    linesTotal: parsed.lines.length,
    allowancesCharges: parsed.allowancesCharges.map((entry) =>
      withoutUndefined({
        kind: entry.kind,
        amount: amount(entry.amount),
        vatCategory: entry.vatCategory,
        vatRate: entry.vatRate,
        reason: entry.reason,
      }),
    ),
    vatBreakdown: parsed.vatBreakdown.map((row) =>
      withoutUndefined({
        category: row.category,
        rate: row.rate,
        taxableAmount: amount(row.taxableAmount),
        taxAmount: amount(row.taxAmount),
        exemptionReason: row.exemptionReason,
        exemptionCode: row.exemptionCode,
      }),
    ),
    totals: withoutUndefined({
      lineNet: amount(totals.lineNet),
      allowances: optionalAmount(totals.allowances),
      charges: optionalAmount(totals.charges),
      net: amount(totals.net),
      tax: amount(totals.tax),
      taxInAccountingCurrency: optionalAmount(
        totals.taxInAccountingCurrency,
        parsed.taxCurrency ?? currency,
      ),
      gross: amount(totals.gross),
      prepaid: optionalAmount(totals.prepaid),
      rounding: optionalAmount(totals.rounding),
      due: amount(totals.due),
    }),
  });
}

/** One trusted sentence: counts, labels, validated amounts; no text from the invoice. */
function summaryOf(
  parsed: ParsedEInvoice,
  suggestion: z.output<typeof einvoiceVoucherSuggestionSchema>,
): string {
  const errors = parsed.findings.filter((finding) => finding.severity === "error").length;
  const warnings = parsed.findings.length - errors;
  const lines = `${String(parsed.lines.length)} line${parsed.lines.length === 1 ? "" : "s"}`;
  const gross = money(parsed.totals.gross, parsed.currency);
  const rule =
    suggestion.taxRuleId === undefined ? "no tax rule" : `tax rule ${String(suggestion.taxRuleId)}`;
  const ready =
    suggestion.blocking.length === 0
      ? "ready to import"
      : `not importable as is (${String(suggestion.blocking.length)} blocking reason(s))`;
  return (
    `E-invoice (${PROFILE_LABELS[parsed.profile]}, ${parsed.syntax.toUpperCase()}): ` +
    `${typeCodeLabel(parsed.typeCode)} with ${lines}, gross ${gross.amount} ${gross.currency}; ` +
    `${String(errors)} error(s), ${String(warnings)} warning(s). Suggested voucher: ` +
    `${suggestion.kind}, ${rule}, ${ready}.`
  );
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as T;
}
