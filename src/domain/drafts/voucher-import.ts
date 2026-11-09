/**
 * From an e-invoice (XRechnung, ZUGFeRD / Factur-X) to a draft voucher: turns the parsed invoice's
 * VAT breakdown (BG-23), the voucher suggestion of the e-invoice module
 * (`einvoice/voucher-suggestion.ts`: direction, contact match, tax rule, dates, blocking findings)
 * and the caller's booking accounts into a create call for {@link prepareVoucherCreateSpec}, which
 * then runs every check of a manual create (regime, rule, ReceiptGuidance B2, supplier,
 * duplicates) and attaches the original file.
 *
 * Rules:
 * - a suggestion with blocking findings (totals or VAT breakdown unreliable, not an invoice, …) is
 *   refused with the module's trusted texts; EUR only;
 * - every VAT rate needs a booking account: `accounts` per rate, else the one `accountDatevId`;
 * - positions come from the parsed BG-23 rows with their original rates, one per row, never from
 *   the suggestion's positions (which the e-invoice module may already have folded for its
 *   display): net amounts (BT-116 taxable amount, allowances and charges included) at the row's
 *   rate, so sevDesk's tax per position (net × rate, rounded) equals the e-invoice's (BR-CO-17).
 *   Under the RESOLVED rule (suggested or the caller's override) that only allows 0 % (no
 *   input-VAT deduction, e.g. rule 10), a row with VAT takes its gross amount at 0 % instead and
 *   the preview says the VAT is not deductible. This is the one place an import folds VAT;
 * - the voucher totals computed from those positions must equal the e-invoice totals (gross, and
 *   net and VAT when nothing was folded); otherwise the import is refused.
 *
 * The suggestion's texts (seller name, number) are third-party data, already cleaned by the parser;
 * they go to sevDesk as data and into preview facts, never into messages.
 */
import { SevdeskError } from "../../sevdesk/errors.js";
import type { SevdeskClient } from "../../sevdesk/types.js";
import type { TaxRegime } from "../account-settings.js";
import { cleanText } from "../common.js";
import type { ParsedEInvoice } from "../einvoice/model.js";
import { parseEInvoice } from "../einvoice/parse.js";
import { add, compare, decimal, isZero, type Money, toDecimalString } from "../money.js";
import type { TaxRule } from "../reference-data.js";
import type { VoucherKind } from "../vouchers.js";
import type { Amounts } from "./positions.js";
import { fact, type PreviewFact } from "./preview.js";
import {
  type CreateExtras,
  prepareVoucherCreateSpec,
  type VoucherCreateSpec,
  type VoucherSavePlan,
} from "./voucher.js";
import {
  EINVOICE_FILE_KINDS,
  readReceiptFile,
  RECEIPT_UPLOADS,
  resolveVoucherRule,
  type VoucherCallOptions,
  type VoucherPositionInput,
  voucherRegime,
} from "./voucher-checks.js";
import type { VoucherImportArgs } from "./voucher-inputs.js";

/**
 * The part of the e-invoice module's `EInvoiceVoucherSuggestion` this import reads (structural, so
 * the module's type is assignable to it).
 */
export interface VoucherSuggestion {
  readonly kind: VoucherKind;
  readonly counterparty: {
    readonly name: string;
    readonly vatId?: string | undefined;
  };
  readonly supplierCandidates: readonly {
    readonly contactId: number;
    readonly matchedBy: string;
  }[];
  /** Set only for exactly one VAT-id or IBAN match. */
  readonly supplierId?: number | undefined;
  readonly taxRuleId?: number | undefined;
  /** Trusted text: why that tax rule. */
  readonly taxRuleReason?: string | undefined;
  /**
   * Trusted text, set when the suggested rule allows only 0 % but the invoice shows VAT (the
   * module's `foldVatForZeroRule`); shown when the import folds under the suggested rule. The
   * suggestion's own `positions` are not read: the import builds them from BG-23.
   */
  readonly foldVatReason?: string | undefined;
  readonly voucherDate: string;
  /** Belegnummer = BT-1. */
  readonly number: string;
  readonly deliveryDate?: string | undefined;
  readonly deliveryDateUntil?: string | undefined;
  readonly paymentDeadline?: string | undefined;
  readonly currency: string;
  readonly totals: {
    readonly net: Money;
    readonly tax: Money;
    readonly gross: Money;
    readonly due: Money;
  };
  /** Trusted texts; any entry refuses the import. */
  readonly blocking: readonly string[];
  /** Trusted texts for the preview. */
  readonly warnings: readonly string[];
}

/** The caller's choices for the import. */
export interface VoucherImportChoices {
  /** One booking account for every VAT rate. */
  readonly accountDatevId?: number | undefined;
  /** A booking account per VAT rate (wins over `accountDatevId` for its rate). */
  readonly accounts?:
    readonly { readonly taxRate: string; readonly accountDatevId: number }[] | undefined;
  /** Wins over the suggestion's contact match. */
  readonly supplierId?: number | undefined;
  /** Wins over the suggested tax rule. */
  readonly taxRuleId?: number | undefined;
  readonly allowDuplicate?: boolean | undefined;
}

/** One VAT breakdown row (BG-23) of the parsed invoice. */
export type VatBreakdownRow = ParsedEInvoice["vatBreakdown"][number];

function refuse(message: string): never {
  throw new SevdeskError({ kind: "validation", message });
}

/**
 * Refuses a suggestion that cannot become a voucher here (blocking findings, foreign currency)
 * before anything else is read.
 */
export function assertImportable(suggestion: VoucherSuggestion): void {
  if (suggestion.blocking.length > 0) {
    refuse(
      `This e-invoice cannot be imported as a voucher: ${suggestion.blocking.join(" ")} ` +
        "Nothing was sent to sevDesk. Create the voucher with sevdesk_voucher_create_draft " +
        "from the checked invoice and attach the file there.",
    );
  }
  if (suggestion.currency !== "EUR") {
    refuse(
      "The e-invoice is not in EUR; this server writes EUR vouchers only. Create the voucher " +
        "in the sevDesk web app.",
    );
  }
}

/** The tax rule id the import uses: the caller's, else the suggestion's (else the default). */
export function importRuleId(
  suggestion: VoucherSuggestion,
  choices: VoucherImportChoices,
): number | undefined {
  return choices.taxRuleId ?? suggestion.taxRuleId;
}

/** A create call plus the import's preview content and totals check. */
export interface ImportedVoucher {
  readonly spec: VoucherCreateSpec;
  readonly extras: CreateExtras;
}

/**
 * Builds the create call from a checked suggestion (see {@link assertImportable}), the parsed
 * invoice's VAT breakdown (BG-23) and the resolved tax rule (`rule`, after the regime check of
 * `resolveVoucherRule`). One position per breakdown row; VAT is folded into the gross amount at
 * 0 % only here, when `rule` allows nothing but 0 %.
 */
export function importedVoucher(
  suggestion: VoucherSuggestion,
  breakdown: readonly VatBreakdownRow[],
  choices: VoucherImportChoices,
  rule: TaxRule,
  regime: TaxRegime | undefined,
): ImportedVoucher {
  if (breakdown.length === 0) {
    refuse("The e-invoice has no VAT breakdown to build positions from.");
  }
  const onlyZero = rule.allowedTaxRates?.length === 1 && rule.allowedTaxRates[0] === 0;
  const folded: string[] = [];
  const positions: VoucherPositionInput[] = breakdown.map((row) => {
    const rate = toDecimalString(row.rate ?? "0");
    const accountDatevId = accountFor(rate, choices);
    const fold = onlyZero && (compare(rate, 0) !== 0 || !isZero(row.taxAmount));
    if (fold) folded.push(rate);
    const amount = fold ? add(row.taxableAmount, row.taxAmount) : decimal(row.taxableAmount);
    if (compare(amount, 0) <= 0 || amount.scale > 2) {
      refuse(
        `The e-invoice's VAT breakdown has a row at ${rate} % with a zero, negative or ` +
          "sub-cent amount, which a voucher position cannot hold. Create the voucher with " +
          "sevdesk_voucher_create_draft from the checked invoice.",
      );
    }
    return {
      accountDatevId,
      amount: toDecimalString(amount),
      taxRate: fold ? "0" : rate,
      comment: `E-Rechnung, USt ${rate} % (${row.category})`,
    };
  });

  const supplierId = choices.supplierId ?? suggestion.supplierId;
  const spec: VoucherCreateSpec = {
    kind: suggestion.kind,
    ...(supplierId === undefined
      ? { supplierName: cleanText(suggestion.counterparty.name, 200) ?? "(unnamed)" }
      : { supplierId }),
    number: cleanText(suggestion.number, 100),
    date: suggestion.voucherDate,
    deliveryDate: suggestion.deliveryDate,
    deliveryDateUntil: suggestion.deliveryDateUntil,
    paymentDeadline: suggestion.paymentDeadline,
    taxRuleId: rule.id,
    amountMode: "net",
    positions,
    allowDuplicate: choices.allowDuplicate === true,
  };

  const facts: PreviewFact[] = [
    fact(
      "Issuer (from the e-invoice)",
      suggestion.counterparty.vatId === undefined
        ? suggestion.counterparty.name
        : `${suggestion.counterparty.name}, VAT id ${suggestion.counterparty.vatId}`,
    ),
    fact(
      "E-invoice totals",
      `net ${suggestion.totals.net.amount} EUR, VAT ${suggestion.totals.tax.amount} EUR, gross ` +
        `${suggestion.totals.gross.amount} EUR`,
    ),
    ...(suggestion.taxRuleReason === undefined || choices.taxRuleId !== undefined
      ? []
      : [fact("Tax rule basis", suggestion.taxRuleReason)]),
  ];
  const warnings: string[] = [...suggestion.warnings];
  if (supplierId === undefined) {
    const candidates = suggestion.supplierCandidates.map((candidate) => candidate.contactId);
    warnings.push(
      candidates.length === 0
        ? "No sevDesk contact matches the issuer; the voucher is saved with the issuer's name " +
            "only. Pass supplierId to link a contact."
        : candidates.length === 1
          ? `Contact ${String(candidates[0])} matches the issuer but was not linked ` +
            "automatically (see the bank-details warning); the voucher is saved with the " +
            "issuer's name only. Pass supplierId to link it once the bank details are checked."
          : `The issuer matches several contacts (${candidates.join(", ")}); the voucher is ` +
            "saved with the issuer's name only. Pass supplierId to link one.",
    );
  }
  if (folded.length > 0) {
    warnings.push(
      choices.taxRuleId === undefined && suggestion.foldVatReason !== undefined
        ? suggestion.foldVatReason
        : `Tax rule ${String(rule.id)} allows no input-VAT deduction, so the VAT of ` +
            `${[...new Set(folded)].join(", ")} % is booked as part of the gross amount at 0 %` +
            (regime === "small_business" ? " (Kleinunternehmer, §19 UStG)." : "."),
    );
  }
  if (compare(suggestion.totals.due.amount, suggestion.totals.gross.amount) !== 0) {
    warnings.push(
      `The amount due (${suggestion.totals.due.amount} EUR) differs from the invoice total ` +
        `(${suggestion.totals.gross.amount} EUR), e.g. after a prepayment; book the payment ` +
        "accordingly.",
    );
  }

  return {
    spec,
    extras: {
      source: " from an e-invoice",
      facts,
      warnings,
      checkTotals: (totals) => {
        checkTotals(totals, suggestion.totals, folded.length > 0);
      },
    },
  };
}

/** The booking account for a VAT rate; refuses a rate without one. */
function accountFor(rate: string, choices: VoucherImportChoices): number {
  const match = choices.accounts?.find((entry) => compare(entry.taxRate, rate) === 0);
  const id = match?.accountDatevId ?? choices.accountDatevId;
  if (id === undefined) {
    refuse(
      `The e-invoice has a VAT rate of ${toDecimalString(rate)} % without a booking account. ` +
        "Pass accountDatevId (one account for all rates) or accounts with an entry for this " +
        "rate (sevdesk_reference_lookup kind=receipt_guidance lists the accounts).",
    );
  }
  return id;
}

/**
 * Refuses when the voucher totals computed from the positions differ from the e-invoice totals:
 * gross always, net and VAT unless VAT was folded into the gross amount.
 */
function checkTotals(
  computed: Amounts,
  invoice: VoucherSuggestion["totals"],
  folded: boolean,
): void {
  const grossDiffers = compare(computed.gross, invoice.gross.amount) !== 0;
  const splitDiffers =
    !folded &&
    (compare(computed.net, invoice.net.amount) !== 0 ||
      compare(computed.tax, invoice.tax.amount) !== 0);
  if (grossDiffers || splitDiffers) {
    refuse(
      `The voucher built from the e-invoice's VAT breakdown (net ${computed.net}, VAT ` +
        `${computed.tax}, gross ${computed.gross} EUR) does not match the e-invoice totals ` +
        `(net ${toDecimalString(invoice.net.amount)}, VAT ${toDecimalString(invoice.tax.amount)}, ` +
        `gross ${toDecimalString(invoice.gross.amount)} EUR), so its sums are unreliable. ` +
        "Nothing was sent to sevDesk. Create the voucher with sevdesk_voucher_create_draft " +
        "from the checked invoice.",
    );
  }
}

/**
 * The e-invoice module's planner (`planVoucherFromEInvoice` in `einvoice/voucher-suggestion.ts`):
 * from the parsed invoice to a voucher suggestion (contact match, tax rule, one position per VAT
 * rate). Passed in by the tool, so the import does not depend on how it reads contacts.
 */
export type VoucherSuggestionPlanner = (
  parsed: ParsedEInvoice,
  context: {
    readonly client: SevdeskClient;
    readonly cacheOwner: object;
    readonly signal?: AbortSignal | undefined;
  },
) => Promise<VoucherSuggestion>;

/**
 * Prepares `sevdesk_voucher_import_einvoice`: reads the file through `options.files` (PDF or
 * XML, from `SEVDESK_FILE_DIRS` or an upload), parses it, asks the planner for the suggestion,
 * refuses what cannot be imported, resolves the tax rule against the account's regime and runs
 * the full create path with the file attached.
 */
export async function prepareVoucherImport(
  client: SevdeskClient,
  args: VoucherImportArgs,
  options: VoucherCallOptions,
  planner: VoucherSuggestionPlanner,
): Promise<VoucherSavePlan> {
  const file = await readReceiptFile(options.files, args.file, EINVOICE_FILE_KINDS);
  const parsed = await parseEInvoice(file.bytes, { fileName: file.name });
  const suggestion = await planner(parsed, {
    client,
    cacheOwner: options.cacheOwner,
    signal: options.signal,
  });
  assertImportable(suggestion);
  const regime = await voucherRegime(client, options);
  const { rule } = resolveVoucherRule(suggestion.kind, importRuleId(suggestion, args), regime);
  const { spec, extras } = importedVoucher(suggestion, parsed.vatBreakdown, args, rule, regime);
  const attach = file.kind !== "xml" || RECEIPT_UPLOADS.xml;
  const plan = await prepareVoucherCreateSpec(client, spec, attach ? file : undefined, options, {
    ...extras,
    warnings: [
      ...(extras.warnings ?? []),
      ...(attach
        ? []
        : [
            "sevDesk does not take a bare XML file as a receipt, so the e-invoice is saved " +
              "without attachment. Attach its PDF (or a print) to the voucher in sevDesk (GoBD).",
          ]),
    ],
  });
  return { preview: plan.preview, state: { ...plan.state, fromEInvoice: true } };
}
