/**
 * The arguments of the voucher (Beleg) write tools: zod input shapes (`sevdesk_voucher_create_draft`,
 * `sevdesk_voucher_update_draft`) and the argument types of the domain functions in `voucher.ts`.
 * Amounts go through `amountInput` (exact decimals, never floats), dates through `isoDateInput`.
 */
import { z } from "zod";

import { amountInput, isoDateInput } from "../common.js";
import { VOUCHER_KINDS, type VoucherKind } from "../vouchers.js";
import {
  AMOUNT_MODES,
  type AmountMode,
  MAX_VOUCHER_POSITIONS,
  type VoucherPositionInput,
} from "./voucher-checks.js";

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const voucherPositionInput = z.strictObject({
  accountDatevId: positiveId.describe(
    "Buchungskonto (booking account, accountDatev id), from sevdesk_reference_lookup " +
      "kind=receipt_guidance (it lists the tax rules and rates each account allows).",
  ),
  amount: amountInput({ allowZero: false }).describe(
    'Betrag of this position in EUR, gross or net as amountsAre says, e.g. "119.00".',
  ),
  taxRate: amountInput({ places: 2 })
    .optional()
    .describe(
      "Steuersatz in percent, e.g. 19, 7 or 0. May be left out when the tax rule allows one " +
        "rate only (e.g. 0 for rule 10).",
    ),
  comment: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("Buchungstext of the position, e.g. what was bought."),
  isAsset: z
    .boolean()
    .optional()
    .describe("Anlagegut: a depreciable asset (AfA is not computed here). Default false."),
});

const positionsInput = z
  .array(voucherPositionInput)
  .min(1)
  .max(MAX_VOUCHER_POSITIONS)
  .describe("Belegpositionen: one per booking account and tax rate.");

const fileInput = z
  .string()
  .min(1)
  .max(1_000)
  .describe(
    "Receipt file (Belegbild: PDF, PNG or JPEG, up to 20 MB) inside SEVDESK_FILE_DIRS, " +
      "absolute or relative to one of those folders. It is uploaded and attached.",
  );

const supplierIdInput = positiveId
  .optional()
  .describe(
    "Lieferant (supplier; the customer of a revenue voucher) as a contact id from " +
      "sevdesk_contacts_search. Pass supplierId or supplierName.",
  );

const supplierNameInput = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe("Supplier name as text, when there is no contact (e.g. a petrol station).");

const numberInput = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .optional()
  .describe("Belegnummer: the receipt's or supplier invoice's own number.");

const amountsAreInput = z
  .enum(AMOUNT_MODES)
  .optional()
  .describe("Whether position amounts are gross (Brutto, default) or net (Netto).");

const taxRuleIdInput = positiveId
  .optional()
  .describe(
    "Steuerregel id. Default: expense 9 (Vorsteuerabziehbare Aufwendungen), on a " +
      "Kleinunternehmer account 10; revenue 1, or 11 for Kleinunternehmer. Others: 8, 12–14 " +
      "(intra-EU, reverse charge), 2–5, 17. Not 18–21. sevdesk_reference_lookup kind=tax_rules.",
  );

const dateInputs = {
  date: isoDateInput.optional().describe("Belegdatum, YYYY-MM-DD; default today (Berlin)."),
  deliveryDate: isoDateInput
    .optional()
    .describe("Leistungsdatum, YYYY-MM-DD; default the voucher date."),
  deliveryDateUntil: isoDateInput
    .optional()
    .describe("End of the service period (Leistungszeitraum bis), YYYY-MM-DD."),
  paymentDeadline: isoDateInput.optional().describe("Fälligkeit (payment deadline), YYYY-MM-DD."),
};

/** Input fields of `sevdesk_voucher_create_draft` (without `dryRun`). */
export const voucherCreateInputShape = {
  kind: z
    .enum(VOUCHER_KINDS)
    .optional()
    .describe(
      "expense (Ausgabe, default: a receipt or supplier invoice, money out) or revenue " +
        "(Einnahme, money in).",
    ),
  supplierId: supplierIdInput,
  supplierName: supplierNameInput,
  number: numberInput,
  ...dateInputs,
  taxRule: taxRuleIdInput,
  amountsAre: amountsAreInput,
  positions: positionsInput,
  file: fileInput.optional(),
  allowDuplicate: z
    .boolean()
    .optional()
    .describe(
      "Create it although a voucher with the same supplier, Belegnummer, date and gross exists.",
    ),
};

/** Input fields of `sevdesk_voucher_update_draft` (without `dryRun`). */
export const voucherUpdateInputShape = {
  id: positiveId.describe("Id of the draft voucher, e.g. from sevdesk_vouchers_list."),
  supplierId: supplierIdInput,
  supplierName: supplierNameInput,
  number: numberInput,
  ...dateInputs,
  taxRule: taxRuleIdInput.describe(
    "New Steuerregel id; every position (stored or new) must allow it. See " +
      "sevdesk_reference_lookup kind=tax_rules.",
  ),
  amountsAre: amountsAreInput.describe(
    "gross or net position amounts; changing it requires positions too.",
  ),
  positions: positionsInput
    .optional()
    .describe("When given, replaces ALL positions; leave out to keep them."),
  file: fileInput
    .optional()
    .describe("Receipt file to attach (PDF, PNG or JPEG inside SEVDESK_FILE_DIRS)."),
};

export interface VoucherCreateArgs {
  readonly kind?: VoucherKind | undefined;
  readonly supplierId?: number | undefined;
  readonly supplierName?: string | undefined;
  readonly number?: string | undefined;
  readonly date?: string | undefined;
  readonly deliveryDate?: string | undefined;
  readonly deliveryDateUntil?: string | undefined;
  readonly paymentDeadline?: string | undefined;
  readonly taxRule?: number | undefined;
  readonly amountsAre?: AmountMode | undefined;
  readonly positions: readonly VoucherPositionInput[];
  readonly file?: string | undefined;
  readonly allowDuplicate?: boolean | undefined;
}

export interface VoucherUpdateArgs {
  readonly id: number;
  readonly supplierId?: number | undefined;
  readonly supplierName?: string | undefined;
  readonly number?: string | undefined;
  readonly date?: string | undefined;
  readonly deliveryDate?: string | undefined;
  readonly deliveryDateUntil?: string | undefined;
  readonly paymentDeadline?: string | undefined;
  readonly taxRule?: number | undefined;
  readonly amountsAre?: AmountMode | undefined;
  readonly positions?: readonly VoucherPositionInput[] | undefined;
  readonly file?: string | undefined;
}

/** Input fields of `sevdesk_voucher_import_einvoice` (without `dryRun`). */
export const voucherImportInputShape = {
  file: z
    .string()
    .min(1)
    .max(1_000)
    .describe(
      "The e-invoice: an XRechnung XML or a ZUGFeRD/Factur-X PDF inside SEVDESK_FILE_DIRS, " +
        "absolute or relative to one of those folders. It is attached to the voucher.",
    ),
  accountDatevId: positiveId
    .optional()
    .describe(
      "Buchungskonto (accountDatev id) for every VAT rate of the invoice; see " +
        "sevdesk_reference_lookup kind=receipt_guidance.",
    ),
  accounts: z
    .array(
      z.strictObject({
        taxRate: amountInput({ places: 2 }).describe("VAT rate in percent, e.g. 19 or 7."),
        accountDatevId: positiveId.describe("Buchungskonto for this rate."),
      }),
    )
    .min(1)
    .max(10)
    .optional()
    .describe("A Buchungskonto per VAT rate; wins over accountDatevId for its rate."),
  supplierId: positiveId
    .optional()
    .describe(
      "Lieferant contact id. Default: the contact that matches the issuer's VAT id or IBAN " +
        "(exactly one), else the issuer's name only; contacts are never created.",
    ),
  taxRuleId: positiveId
    .optional()
    .describe(
      "Steuerregel. Default: derived from the invoice's VAT categories and the account's VAT " +
        "regulation (e.g. 9, or 10 for Kleinunternehmer).",
    ),
  allowDuplicate: z
    .boolean()
    .optional()
    .describe(
      "Import it although a voucher with the same supplier, number, date and gross exists.",
    ),
};

export interface VoucherImportArgs {
  readonly file: string;
  readonly accountDatevId?: number | undefined;
  readonly accounts?:
    readonly { readonly taxRate: string; readonly accountDatevId: number }[] | undefined;
  readonly supplierId?: number | undefined;
  readonly taxRuleId?: number | undefined;
  readonly allowDuplicate?: boolean | undefined;
}
